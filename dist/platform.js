"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TuyaEuromACPlatform = void 0;
const settings_1 = require("./settings");
const platformAccessory_1 = require("./platformAccessory");
/**
 * TuyaEuromACPlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
class TuyaEuromACPlatform {
    log;
    config;
    api;
    Service;
    Characteristic;
    // this is used to track restored cached accessories
    accessories = [];
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.log.debug('Finished initializing platform:', this.config.name);
        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            // run the method to discover / register your devices as accessories
            this.discoverDevices();
        });
    }
    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        // add the restored accessory to the accessories cache so we can track if it has already been registered
        this.accessories.push(accessory);
    }
    /**
     * This is an example method showing how to register discovered accessories.
     * Accessories must only be registered once, previously created accessories
     * must not be registered again to prevent "duplicate UUID" errors.
     */
    discoverDevices() {
        // Determine configuration from user config
        const deviceId = this.config.id;
        const deviceKey = this.config.key;
        const deviceIp = this.config.ip || undefined; // If undefined, tuyapi will try to resolve it
        const deviceVersion = this.config.version || '3.4';
        if (!deviceId || !deviceKey) {
            this.log.error('Please configure the Device ID and Local Key in the Homebridge UI.');
            return;
        }
        const deviceConfig = {
            id: deviceId,
            key: deviceKey,
            ip: deviceIp,
            version: deviceVersion,
        };
        const uuid = this.api.hap.uuid.generate(deviceId);
        // see if an accessory with the same uuid has already been registered and restored from
        // the cached devices we stored in the `configureAccessory` method above
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        if (existingAccessory) {
            // the accessory already exists
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
            // create the accessory handler for the restored accessory
            new platformAccessory_1.TuyaEuromACAccessory(this, existingAccessory, deviceConfig);
        }
        else {
            // the accessory does not yet exist, so we need to create it
            this.log.info('Adding new accessory:', 'Eurom AC');
            // create a new accessory
            const accessory = new this.api.platformAccessory('Eurom AC', uuid);
            // create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            new platformAccessory_1.TuyaEuromACAccessory(this, accessory, deviceConfig);
            // link the accessory to your platform
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
        }
    }
}
exports.TuyaEuromACPlatform = TuyaEuromACPlatform;
