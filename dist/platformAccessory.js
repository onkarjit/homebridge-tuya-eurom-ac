"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TuyaEuromACAccessory = void 0;
const TuyaDevice = require('tuyapi');
class TuyaEuromACAccessory {
    platform;
    accessory;
    deviceConfig;
    service;
    device;
    connected = false;
    // Local state cache
    state = {
        active: 0,
        currentTemp: 20,
        targetTemp: 20,
        targetMode: 0, // Auto=0, Heat=1, Cool=2
        fanSpeed: 100,
    };
    pendingSetData = {};
    debounceTimeout = null;
    reconnectTimeout = null;
    constructor(platform, accessory, deviceConfig) {
        this.platform = platform;
        this.accessory = accessory;
        this.deviceConfig = deviceConfig;
        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)
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
        // Initialize Tuya Device
        this.device = new TuyaDevice({
            id: this.deviceConfig.id,
            key: this.deviceConfig.key,
            ip: this.deviceConfig.ip,
            version: this.deviceConfig.version,
        });
        this.setupTuyaListeners();
        this.connectTuya();
    }
    connectTuya() {
        this.platform.log.info('Connecting to Tuya device...');
        // Find device on network then connect
        this.device.find().then(() => {
            // Connect to device
            this.device.connect();
        }).catch((error) => {
            this.platform.log.error('Tuya find error:', error);
            this.scheduleReconnect();
        });
    }
    setupTuyaListeners() {
        this.device.on('connected', () => {
            this.platform.log.info('Connected to Tuya device!');
            this.connected = true;
        });
        this.device.on('disconnected', () => {
            this.platform.log.warn('Disconnected from Tuya device.');
            this.connected = false;
            this.scheduleReconnect();
        });
        this.device.on('error', (error) => {
            this.platform.log.error('Tuya device error!', error);
            this.connected = false;
            this.scheduleReconnect();
        });
        this.device.on('data', (data) => {
            // Handle incoming state updates from device
            if (data.dps) {
                this.platform.log.debug('Received data from Tuya:', data.dps);
                this.updateStateFromTuya(data.dps);
            }
        });
        this.device.on('dp-refresh', (data) => {
            if (data.dps) {
                this.platform.log.debug('Received dp-refresh from Tuya:', data.dps);
                this.updateStateFromTuya(data.dps);
            }
        });
    }
    scheduleReconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(() => {
            if (!this.connected) {
                this.connectTuya();
            }
        }, 10000); // Try to reconnect every 10 seconds
    }
    updateStateFromTuya(dps) {
        let updated = false;
        // Power (DP 1)
        if (dps['1'] !== undefined) {
            this.state.active = dps['1'] ? 1 : 0;
            this.service.updateCharacteristic(this.platform.Characteristic.Active, this.state.active);
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
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemp);
        }
        // Operating Mode (DP 101)
        if (dps['101'] !== undefined) {
            const modeStr = String(dps['101']);
            if (modeStr === '1') {
                this.state.targetMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
            }
            else if (modeStr === '2') {
                this.state.targetMode = this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
            }
            else if (modeStr === '5') {
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
            }
            else if (fanStr === '2') {
                this.state.fanSpeed = 50;
            }
            else if (fanStr === '3') {
                this.state.fanSpeed = 25;
            }
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.fanSpeed);
        }
        if (updated) {
            this.updateDynamicCurrentState();
        }
    }
    updateDynamicCurrentState() {
        let currentState = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        if (this.state.active === 1) {
            if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
                currentState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
            }
            else if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) {
                currentState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
            }
            else {
                // Auto mode
                if (this.state.currentTemp > this.state.targetTemp) {
                    currentState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
                }
                else if (this.state.currentTemp < this.state.targetTemp) {
                    currentState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
                }
                else {
                    currentState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
                }
            }
        }
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, currentState);
    }
    // --- Helpers for queueing set commands to Tuya ---
    queueTuyaSet(dp, value) {
        this.pendingSetData[dp] = value;
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        // 400ms debounce
        this.debounceTimeout = setTimeout(() => {
            this.sendPendingSetData();
        }, 400);
    }
    sendPendingSetData() {
        if (!this.connected) {
            this.platform.log.warn('Cannot send command to Tuya, device disconnected.');
            this.pendingSetData = {};
            return;
        }
        const dataToSend = { ...this.pendingSetData };
        this.pendingSetData = {}; // Clear pending
        this.platform.log.debug('Sending to Tuya:', dataToSend);
        this.device.set({
            multiple: true,
            data: dataToSend
        }).catch((error) => {
            this.platform.log.error('Tuya set error:', error);
        });
    }
    // --- Characteristic Handlers ---
    async setActive(value) {
        const isActive = value;
        if (this.state.active !== isActive) {
            this.state.active = isActive;
            this.queueTuyaSet('1', isActive === 1);
            this.updateDynamicCurrentState();
        }
    }
    async getActive() {
        return this.state.active;
    }
    async getCurrentHeaterCoolerState() {
        let currentState = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        if (this.state.active === 1) {
            if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
                currentState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
            }
            else if (this.state.targetMode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) {
                currentState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
            }
            else {
                currentState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
            }
        }
        return currentState;
    }
    async setTargetHeaterCoolerState(value) {
        const targetMode = value;
        if (this.state.targetMode !== targetMode) {
            this.state.targetMode = targetMode;
            let tuyaMode = '5'; // Auto by default
            if (targetMode === this.platform.Characteristic.TargetHeaterCoolerState.COOL)
                tuyaMode = '1';
            else if (targetMode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT)
                tuyaMode = '2';
            this.queueTuyaSet('101', tuyaMode);
            this.updateDynamicCurrentState();
        }
    }
    async getTargetHeaterCoolerState() {
        return this.state.targetMode;
    }
    async getCurrentTemperature() {
        return this.state.currentTemp;
    }
    async setTargetTemperature(value) {
        const temp = value;
        if (this.state.targetTemp !== temp) {
            this.state.targetTemp = temp;
            this.queueTuyaSet('2', temp);
            // CRITICAL HACK: Sync both cooling and heating thresholds
            this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, temp);
            this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, temp);
            this.updateDynamicCurrentState();
        }
    }
    async getTargetTemperature() {
        return this.state.targetTemp;
    }
    async setRotationSpeed(value) {
        const speed = value;
        if (this.state.fanSpeed !== speed) {
            this.state.fanSpeed = speed;
            let tuyaSpeed = '1'; // High by default
            if (speed <= 33) {
                tuyaSpeed = '3'; // Low
            }
            else if (speed <= 66) {
                tuyaSpeed = '2'; // Med
            }
            this.queueTuyaSet('104', tuyaSpeed);
        }
    }
    async getRotationSpeed() {
        return this.state.fanSpeed;
    }
}
exports.TuyaEuromACAccessory = TuyaEuromACAccessory;
