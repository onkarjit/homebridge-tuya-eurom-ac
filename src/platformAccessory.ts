import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { TuyaEuromACPlatform } from './platform';
const TuyaDevice = require('tuyapi');

export class TuyaEuromACAccessory {
  private service: Service;
  private device: any;
  private connected = false;
  private isConnecting = false;

  // Local state cache
  private state = {
    active: 0,
    currentTemp: 20,
    targetTemp: 20,
    targetMode: 0, // Auto=0, Heat=1, Cool=2
    fanSpeed: 100,
    displayUnits: false, // false = C, true = F
  };

  private debounceTimeout: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private queuedPayload: Record<string, any> = {};
  private isSending: boolean = false;
  private isHardwareCoolingDown: boolean = false;
  private tempDebounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: TuyaEuromACPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly deviceConfig: any,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eurom')
      .setCharacteristic(this.platform.Characteristic.Model, 'Coolperfect 180 (Baoshi Chip)')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, deviceConfig.id);

    // get the HeaterCooler service if it exists, otherwise create a new HeaterCooler service
    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) || this.accessory.addService(this.platform.Service.HeaterCooler);

    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // Register handlers for Active
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // Register handlers for CurrentHeaterCoolerState (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentHeaterCoolerState.bind(this));

    // Register handlers for TargetHeaterCoolerState
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onSet(this.setTargetHeaterCoolerState.bind(this))
      .onGet(this.getTargetHeaterCoolerState.bind(this));

    // Register handlers for CurrentTemperature
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // Register handlers for CoolingThresholdTemperature
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: 16,
        maxValue: 35,
        minStep: 1,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    // Register handlers for HeatingThresholdTemperature
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: 16,
        maxValue: 35,
        minStep: 1,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    // Register handlers for RotationSpeed (Fan Speed)
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // Register handlers for TemperatureDisplayUnits
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onSet(this.setTemperatureDisplayUnits.bind(this))
      .onGet(this.getTemperatureDisplayUnits.bind(this));

    // Initialize Tuya Device
    this.device = new TuyaDevice({
      id: this.deviceConfig.id,
      key: this.deviceConfig.key,
      ip: this.deviceConfig.ip,
      version: this.deviceConfig.version,
      timeout: 7.5,
    });

    this.setupTuyaListeners();
    this.connectTuya();
  }

  private connectTuya() {
    if (this.isConnecting || this.connected) return;
    this.isConnecting = true;
    this.platform.log.info('Connecting to Tuya device...');
    
    // Find device on network then connect
    this.device.find().then(() => {
      // Connect to device
      this.device.connect();
    }).catch((error: any) => {
      this.platform.log.error('Tuya find error:', error);
      this.isConnecting = false;
      this.scheduleReconnect();
    });
  }

  private setupTuyaListeners() {
    this.device.on('connected', () => {
      this.platform.log.info('Connected to Tuya device!');
      this.connected = true;
      this.isConnecting = false;
      this.startHeartbeat();

      // Process pending commands after a delay to allow crypto handshake
      if (Object.keys(this.queuedPayload).length > 0) {
        this.platform.log.info('Waiting 1000ms before flushing queued payload...');
        setTimeout(() => {
          if (this.connected) {
            this.sendQueuedPayload();
          }
        }, 1000);
      }
    });

    this.device.on('disconnected', () => {
      this.platform.log.warn('Disconnected from Tuya device.');
      this.connected = false;
      this.isConnecting = false;
      this.stopHeartbeat();
      if (this.tempDebounceTimer) clearTimeout(this.tempDebounceTimer);
      this.device.disconnect(); // Explicitly destroy socket
      this.scheduleReconnect();
    });

    this.device.on('error', (error: any) => {
      this.platform.log.error('Tuya device error!', error);
      this.connected = false;
      this.isConnecting = false;
      this.stopHeartbeat();
      if (this.tempDebounceTimer) clearTimeout(this.tempDebounceTimer);
      this.device.disconnect(); // Explicitly destroy socket
      this.scheduleReconnect();
    });

    this.device.on('data', (data: any) => {
      // Handle incoming state updates from device
      if (data.dps) {
        this.platform.log.debug('Received data from Tuya:', data.dps);
        this.updateStateFromTuya(data.dps);
      }
    });

    this.device.on('dp-refresh', (data: any) => {
      if (data.dps) {
        this.platform.log.debug('Received dp-refresh from Tuya:', data.dps);
        this.updateStateFromTuya(data.dps);
      }
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat(); // Ensure no duplicates
    this.heartbeatInterval = setInterval(() => {
      if (this.connected) {
        this.platform.log.debug('Sending heartbeat ping to Tuya device...');
        this.device.get({ schema: true }).catch((error: any) => {
          this.platform.log.debug('Heartbeat ping failed:', error);
          // Let the error listener handle the disconnection if the socket dropped
        });
      }
    }, 45000); // 45 seconds
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.reconnectTimeout = setTimeout(() => {
      if (!this.connected) {
        this.connectTuya();
      }
    }, 3000); // Try to reconnect every 3 seconds
  }

  private updateStateFromTuya(dps: any) {
    let updated = false;

    // Power (DP 1)
    if (dps['1'] !== undefined) {
      this.state.active = dps['1'] ? 1 : 0;
      this.service.updateCharacteristic(this.platform.Characteristic.Active, this.state.active);
      if (this.state.active === 0) {
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE);
      }
      updated = true;
    }

    // Target Temperature (DP 2)
    if (dps['2'] !== undefined) {
      this.state.targetTemp = dps['2'];
      this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.state.targetTemp);
      this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.state.targetTemp);
      updated = true;
    }

    // Current Temperature (DP 3)
    if (dps['3'] !== undefined) {
      this.state.currentTemp = dps['3'];
      
      if (this.tempDebounceTimer) {
        clearTimeout(this.tempDebounceTimer);
      }
      
      this.tempDebounceTimer = setTimeout(() => {
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemp);
        this.tempDebounceTimer = undefined;
      }, 15000); // 15 seconds
    }

    // Operating Mode (DP 101)
    if (dps['101'] !== undefined) {
      const modeStr = String(dps['101']);
      if (modeStr === '1') {
        this.state.targetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
      } else if (modeStr === '2') {
        this.state.targetMode = this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
      } else if (modeStr === '5') {
        this.state.targetMode = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
      }
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.state.targetMode);
      updated = true;
    }

    // Fan Speed (DP 104)
    if (dps['104'] !== undefined) {
      const fanStr = String(dps['104']);
      if (fanStr === '1') {
        this.state.fanSpeed = 100;
      } else if (fanStr === '2') {
        this.state.fanSpeed = 50;
      } else if (fanStr === '3') {
        this.state.fanSpeed = 25;
      }
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.fanSpeed);
    }

    // Temperature Display Units (DP 109)
    if (dps['109'] !== undefined) {
      this.state.displayUnits = dps['109'] === true;
      const unit = this.state.displayUnits 
        ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT 
        : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
      this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, unit);
    }

    if (updated) {
      this.updateDynamicCurrentState();
    }
  }

  private updateDynamicCurrentState() {
    let currentState = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;

    if (this.state.active === 1) {
      if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
        currentState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
      } else if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) {
        currentState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      } else {
        // Auto mode
        if (this.state.currentTemp > this.state.targetTemp) {
          currentState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        } else if (this.state.currentTemp < this.state.targetTemp) {
          currentState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
        } else {
          currentState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
        }
      }
    }

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, currentState);
  }

  // --- Helpers for queueing set commands to Tuya ---

  private queueTuyaSet(dp: string, value: any) {
    this.queuedPayload[dp] = value;
    
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    // 800ms debounce
    this.debounceTimeout = setTimeout(() => {
      this.sendQueuedPayload();
    }, 800);
  }

  private sendQueuedPayload() {
    if (Object.keys(this.queuedPayload).length === 0) return;
    
    // In-flight Mutex
    if (this.isSending) {
      this.platform.log.debug('Command already in-flight. Queuing...');
      return;
    }

    // Hardware Cooldown Lock
    if (this.isHardwareCoolingDown) {
      this.platform.log.debug('Hardware is cooling down from mechanical shift. Queuing...');
      return;
    }

    if (!this.connected) {
      this.platform.log.warn('Device disconnected. Payload queued for reconnect.');
      this.scheduleReconnect();
      return;
    }

    const dataToSend = { ...this.queuedPayload };
    this.isSending = true;

    this.platform.log.debug('Sending to Tuya:', dataToSend);
    
    this.device.set({
      multiple: true,
      data: dataToSend
    }).then(() => {
      this.isSending = false;
      
      // Clear successfully sent data from the queue
      for (const key of Object.keys(dataToSend)) {
        if (this.queuedPayload[key] === dataToSend[key]) {
          delete this.queuedPayload[key];
        }
      }
      
      // Trigger hardware cooldown if this was a heavy mechanical shift
      if (dataToSend['1'] !== undefined || dataToSend['101'] !== undefined) {
        this.isHardwareCoolingDown = true;
        setTimeout(() => {
          this.isHardwareCoolingDown = false;
          // Flush any commands that queued up during the cooldown
          if (Object.keys(this.queuedPayload).length > 0) {
            this.sendQueuedPayload();
          }
        }, 3500);
      } else {
        // If no cooldown, flush next commands immediately
        if (Object.keys(this.queuedPayload).length > 0) {
          this.sendQueuedPayload();
        }
      }
    }).catch((error: any) => {
      this.platform.log.debug('Tuya set error/timeout. Re-queueing payload:', error);
      this.isSending = false;
      this.connected = false;
      this.isConnecting = false;
      this.device.disconnect();
      this.scheduleReconnect();
    });
  }

  // --- Characteristic Handlers ---

  async setActive(value: CharacteristicValue) {
    const isActive = value as number;
    if (this.state.active !== isActive) {
      this.state.active = isActive;
      this.queueTuyaSet('1', isActive === 1);
      
      if (isActive === 0) {
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE);
      } else {
        this.updateDynamicCurrentState();
      }
    }
  }

  async getActive(): Promise<CharacteristicValue> {
    return this.state.active;
  }

  async getCurrentHeaterCoolerState(): Promise<CharacteristicValue> {
    if (this.state.active === 0) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
    } else if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
    } else {
      // Auto mode
      if (this.state.currentTemp > this.state.targetTemp) {
        return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
      } else if (this.state.currentTemp < this.state.targetTemp) {
        return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      } else {
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      }
    }
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue) {
    const targetMode = value as number;
    let tuyaMode = '5'; // Auto by default
    if (targetMode === this.platform.Characteristic.TargetHeaterCoolerState.COOL) tuyaMode = '1';
    else if (targetMode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) tuyaMode = '2';

    if (this.state.targetMode !== targetMode || this.state.active === 0) {
      this.state.targetMode = targetMode;

      if (this.state.active === 0) {
        this.platform.log.info('AC is off. Powering on along with setting mode...');
        this.state.active = 1;
        this.queueTuyaSet('1', true);
      }

      this.queueTuyaSet('101', tuyaMode);
      this.updateDynamicCurrentState();
    }
  }

  async getTargetHeaterCoolerState(): Promise<CharacteristicValue> {
    return this.state.targetMode;
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.state.currentTemp;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    const temp = value as number;
    if (this.state.targetTemp !== temp || this.state.active === 0) {
      this.state.targetTemp = temp;
      
      // CRITICAL HACK: Sync both cooling and heating thresholds
      this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, temp);
      this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, temp);

      if (this.state.active === 0) {
        this.platform.log.info('AC is off. Powering on along with setting temperature...');
        this.state.active = 1;
        this.queueTuyaSet('1', true);
      }

      this.queueTuyaSet('2', temp);
      this.updateDynamicCurrentState();
    }
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.state.targetTemp;
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const speed = value as number;
    if (this.state.fanSpeed !== speed) {
      this.state.fanSpeed = speed;
      let tuyaSpeed = '1'; // High by default
      if (speed <= 33) {
        tuyaSpeed = '3'; // Low
      } else if (speed <= 66) {
        tuyaSpeed = '2'; // Med
      }

      this.queueTuyaSet('104', tuyaSpeed);
    }
  }

  async getRotationSpeed(): Promise<CharacteristicValue> {
    return this.state.fanSpeed;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    const isFahrenheit = value === this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    if (this.state.displayUnits !== isFahrenheit) {
      this.state.displayUnits = isFahrenheit;
      this.queueTuyaSet('109', isFahrenheit);
    }
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    return this.state.displayUnits 
      ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT 
      : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }
}
