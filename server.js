const fs = require('fs');
const cap = safeRequireCap();
const cors = require('cors');
const readline = require('readline');
const winston = require('winston');
const zlib = require('zlib');
const express = require('express');
const http = require('http');
const net = require('net');
const path = require('path');
const { Server } = require('socket.io');
const fsPromises = require('fs').promises;
const PacketProcessor = require('./algo/packet');
const Readable = require('stream').Readable;
const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;
const print = console.log;
const app = express();
const { exec } = require('child_process');
const findDefaultNetworkDevice = require('./algo/netInterfaceUtil');

const skillConfig = require('./tables/skill_names_en.json');
const VERSION = '3.3.1';
const SETTINGS_PATH = path.join('./settings.json');
let globalSettings = {
    autoClearOnServerChange: true,
    autoClearOnTimeout: false,
    onlyRecordEliteDummy: false,
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});
const devices = cap.deviceList();

// Pause statistics status
let isPaused = false;

function warnAndExit(text) {
    console.log(`\x1b[31m${text}\x1b[0m`);
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    process.exit(1);
}

function safeRequireCap() {
    try {
        return require('cap');
    } catch (e) {
        console.error(e);
        warnAndExit(
            'Failed to load the PCAP module. Please verify that the required Node.js dependencies are installed and ensure that Npcap/WinPcap is properly installed.',
        );
    }
}

function ask(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

function getSubProfessionBySkillId(skillId) {
    switch (skillId) {
        case 1241:
            return 'Frostbeam';
        case 2307:
        case 2361:
        case 55302:
            return 'Concerto';
        case 20301:
            return 'Lifebind';
        case 1518:
        case 1541:
        case 21402:
            return 'Smite';
        case 2306:
            return 'Resonance';
        case 120901:
        case 120902:
            return 'Icicle';
        case 1714:
        case 1734:
            return 'Iaido Slash';
        case 44701:
        case 179906:
            return 'Moonstrike';
        case 220112:
        case 2203622:
            return 'Falconry';
        case 2292:
        case 1700820:
        case 1700825:
        case 1700827:
            return 'Wildpack';
        case 1419:
            return 'Skyward';
        case 1405:
        case 1418:
            return 'Vanguard';
        case 2405:
            return 'Recovery';
        case 2406:
            return 'Shield';
        case 199902:
            return 'Earthfort';
        case 1930:
        case 1931:
        case 1934:
        case 1935:
            return 'Block';
        default:
            return '';
    }
}

class Lock {
    constructor() {
        this.queue = [];
        this.locked = false;
    }

    async acquire() {
        if (this.locked) {
            return new Promise((resolve) => this.queue.push(resolve));
        }
        this.locked = true;
    }

    release() {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.locked = false;
        }
    }
}

// General statistics class for handling damage or healing data
class StatisticData {
    constructor(user, type, element, name) {
        this.user = user;
        this.type = type || '';
        this.element = element || '';
        this.name = name || '';
        this.stats = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0, // Only used for damage statistics
            total: 0,
        };
        this.count = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.realtimeWindow = []; // Real-time statistics window
        this.timeRange = []; // Time range [start time, end time]
        this.realtimeStats = {
            value: 0,
            max: 0,
        };
    }

    /** Add data record
     * @param {number} value - Value
     * @param {boolean} isCrit - Whether it's a critical hit
     * @param {boolean} isLucky - Whether it's lucky
     * @param {number} hpLessenValue - HP decrease amount (only used for damage)
     */
    addRecord(value, isCrit, isLucky, hpLessenValue = 0) {
        const now = Date.now();

        // Update numerical statistics
        if (isCrit) {
            if (isLucky) {
                this.stats.crit_lucky += value;
            } else {
                this.stats.critical += value;
            }
        } else if (isLucky) {
            this.stats.lucky += value;
        } else {
            this.stats.normal += value;
        }
        this.stats.total += value;
        this.stats.hpLessen += hpLessenValue;

        // Update count statistics
        if (isCrit) {
            this.count.critical++;
        }
        if (isLucky) {
            this.count.lucky++;
        }
        if (!isCrit && !isLucky) {
            this.count.normal++;
        }
        this.count.total++;

        this.realtimeWindow.push({
            time: now,
            value,
        });

        if (this.timeRange[0]) {
            this.timeRange[1] = now;
        } else {
            this.timeRange[0] = now;
        }
    }

    /** Update real-time statistics */
    updateRealtimeStats() {
        const now = Date.now();

        // Clear data older than 1 second
        while (this.realtimeWindow.length > 0 && now - this.realtimeWindow[0].time > 1000) {
            this.realtimeWindow.shift();
        }

        // Calculate current real-time value
        this.realtimeStats.value = 0;
        for (const entry of this.realtimeWindow) {
            this.realtimeStats.value += entry.value;
        }

        // Update maximum value
        if (this.realtimeStats.value > this.realtimeStats.max) {
            this.realtimeStats.max = this.realtimeStats.value;
        }
    }

    /** Calculate total per second statistics */
    getTotalPerSecond() {
        if (!this.timeRange[0] || !this.timeRange[1]) {
            return 0;
        }
        const totalPerSecond = (this.stats.total / (this.timeRange[1] - this.timeRange[0])) * 1000 || 0;
        if (!Number.isFinite(totalPerSecond)) return 0;
        return totalPerSecond;
    }

    /** Reset data */
    reset() {
        this.stats = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0,
            total: 0,
        };
        this.count = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.realtimeWindow = [];
        this.timeRange = [];
        this.realtimeStats = {
            value: 0,
            max: 0,
        };
    }
}

class UserData {
    constructor(uid) {
        this.uid = uid;
        this.name = '';
        this.damageStats = new StatisticData(this, 'Damage');
        this.healingStats = new StatisticData(this, 'Healing');
        this.takenDamage = 0; // Damage taken
        this.deadCount = 0; // Death count
        this.profession = 'Unknown';
        this.skillUsage = new Map(); // Skill usage statistics
        this.fightPoint = 0; // Total fight point
        this.subProfession = '';
        this.attr = {};
    }

    /** Add damage record
     * @param {number} skillId - Skill ID/Buff ID
     * @param {string} element - Skill element attribute
     * @param {number} damage - Damage value
     * @param {boolean} isCrit - Whether it's a critical hit
     * @param {boolean} [isLucky] - Whether it's lucky
     * @param {boolean} [isCauseLucky] - Whether it causes lucky
     * @param {number} hpLessenValue - HP decrease amount
     */
    addDamage(skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue = 0) {
        this.damageStats.addRecord(damage, isCrit, isLucky, hpLessenValue);
        // Record skill usage
        const skillName = skillConfig[skillId] ?? skillId;
        if (!this.skillUsage.has('Damage-' + skillName)) {
            this.skillUsage.set('Damage-' + skillName, new StatisticData(this, 'Damage', element, skillName));
        }
        this.skillUsage.get('Damage-' + skillName).addRecord(damage, isCrit, isCauseLucky, hpLessenValue);
        this.skillUsage.get('Damage-' + skillName).realtimeWindow.length = 0;

        const subProfession = getSubProfessionBySkillId(skillId);
        if (subProfession) {
            this.setSubProfession(subProfession);
        }
    }

    /** Add healing record
     * @param {number} skillId - Skill ID/Buff ID
     * @param {string} element - Skill element attribute
     * @param {number} healing - Healing value
     * @param {boolean} isCrit - Whether it's a critical hit
     * @param {boolean} [isLucky] - Whether it's lucky
     * @param {boolean} [isCauseLucky] - Whether it causes lucky
     */
    addHealing(skillId, element, healing, isCrit, isLucky, isCauseLucky) {
        this.healingStats.addRecord(healing, isCrit, isLucky);
        // Record skill usage
        const skillName = skillConfig[skillId] ?? skillId;
        if (!this.skillUsage.has('Healing-' + skillName)) {
            this.skillUsage.set('Healing-' + skillName, new StatisticData(this, 'Healing', element, skillName));
        }
        this.skillUsage.get('Healing-' + skillName).addRecord(healing, isCrit, isCauseLucky);
        this.skillUsage.get('Healing-' + skillName).realtimeWindow.length = 0;

        const subProfession = getSubProfessionBySkillId(skillId);
        if (subProfession) {
            this.setSubProfession(subProfession);
        }
    }

    /** Add taken damage record
     * @param {number} damage - Damage taken
     * @param {boolean} isDead - Whether it's fatal damage
     * */
    addTakenDamage(damage, isDead) {
        this.takenDamage += damage;
        if (isDead) this.deadCount++;
    }

    /** Update real-time DPS and HPS - Calculate total damage and healing in the past 1 second */
    updateRealtimeDps() {
        this.damageStats.updateRealtimeStats();
        this.healingStats.updateRealtimeStats();
    }

    /** Calculate total DPS */
    getTotalDps() {
        return this.damageStats.getTotalPerSecond();
    }

    /** Calculate total HPS */
    getTotalHps() {
        return this.healingStats.getTotalPerSecond();
    }

    /** Get combined count statistics */
    getTotalCount() {
        return {
            normal: this.damageStats.count.normal + this.healingStats.count.normal,
            critical: this.damageStats.count.critical + this.healingStats.count.critical,
            lucky: this.damageStats.count.lucky + this.healingStats.count.lucky,
            total: this.damageStats.count.total + this.healingStats.count.total,
        };
    }

    /** Get user data summary */
    getSummary() {
        return {
            realtime_dps: this.damageStats.realtimeStats.value,
            realtime_dps_max: this.damageStats.realtimeStats.max,
            total_dps: this.getTotalDps(),
            total_damage: { ...this.damageStats.stats },
            total_count: this.getTotalCount(),
            realtime_hps: this.healingStats.realtimeStats.value,
            realtime_hps_max: this.healingStats.realtimeStats.max,
            total_hps: this.getTotalHps(),
            total_healing: { ...this.healingStats.stats },
            taken_damage: this.takenDamage,
            profession: this.profession + (this.subProfession ? `-${this.subProfession}` : ''),
            name: this.name,
            fightPoint: this.fightPoint,
            hp: this.attr.hp,
            max_hp: this.attr.max_hp,
            dead_count: this.deadCount,
        };
    }

    /** Get skill statistics data */
    getSkillSummary() {
        const skills = {};
        for (const [skillKey, stat] of this.skillUsage) {
            const total = stat.stats.normal + stat.stats.critical + stat.stats.lucky + stat.stats.crit_lucky;
            const critCount = stat.count.critical;
            const luckyCount = stat.count.lucky;
            const critRate = stat.count.total > 0 ? critCount / stat.count.total : 0;
            const luckyRate = stat.count.total > 0 ? luckyCount / stat.count.total : 0;
            const name = stat.name ?? skillKey;
            const elementype = stat.element;

            skills[skillKey] = {
                displayName: name,
                type: stat.type,
                elementype: elementype,
                totalDamage: stat.stats.total,
                totalCount: stat.count.total,
                critCount: stat.count.critical,
                luckyCount: stat.count.lucky,
                critRate: critRate,
                luckyRate: luckyRate,
                damageBreakdown: { ...stat.stats },
                countBreakdown: { ...stat.count },
            };
        }
        return skills;
    }

    /** Set profession
     * @param {string} profession - Profession name
     * */
    setProfession(profession) {
        if (profession !== this.profession) this.setSubProfession('');
        this.profession = profession;
    }

    /** Set sub-profession
     * @param {string} subProfession - Sub-profession name
     * */
    setSubProfession(subProfession) {
        this.subProfession = subProfession;
    }

    /** Set name
     * @param {string} name - Name
     * */
    setName(name) {
        this.name = name;
    }

    /** Set user total fight point
     * @param {number} fightPoint - Total fight point
     */
    setFightPoint(fightPoint) {
        this.fightPoint = fightPoint;
    }

    /** Set additional data
     * @param {string} key
     * @param {any} value
     */
    setAttrKV(key, value) {
        this.attr[key] = value;
    }

    /** Reset data - Reserved */
    reset() {
        this.damageStats.reset();
        this.healingStats.reset();
        this.takenDamage = 0;
        this.skillUsage.clear();
        this.fightPoint = 0;
    }
}

// User data manager
class UserDataManager {
    constructor(logger) {
        this.logger = logger;
        this.users = new Map();
        this.userCache = new Map(); // User name and profession cache
        this.cacheFilePath = './users.json';

        // Throttling related configuration
        this.saveThrottleDelay = 2000; // 2-second throttle delay to avoid frequent disk writes
        this.saveThrottleTimer = null;
        this.pendingSave = false;

        this.hpCache = new Map(); // This frequently changing data won't be saved to disk
        this.startTime = Date.now();

        this.logLock = new Lock();
        this.logDirExist = new Set();

        this.enemyCache = {
            name: new Map(),
            hp: new Map(),
            maxHp: new Map(),
        };

        // Auto-save
        this.lastAutoSaveTime = 0;
        this.lastLogTime = 0;
        setInterval(() => {
            if (this.lastLogTime < this.lastAutoSaveTime) return;
            this.lastAutoSaveTime = Date.now();
            this.saveAllUserData();
        }, 10 * 1000);
    }

    /** Initialization method - Asynchronously load user cache */
    async initialize() {
        await this.loadUserCache();
    }

    /** Load user cache */
    async loadUserCache() {
        try {
            await fsPromises.access(this.cacheFilePath);
            const data = await fsPromises.readFile(this.cacheFilePath, 'utf8');
            const cacheData = JSON.parse(data);
            this.userCache = new Map(Object.entries(cacheData));
            this.logger.info(`Loaded ${this.userCache.size} user cache entries`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.error('Failed to load user cache:', error);
            }
        }
    }

    /** Save user cache */
    async saveUserCache() {
        try {
            const cacheData = Object.fromEntries(this.userCache);
            await fsPromises.writeFile(this.cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf8');
        } catch (error) {
            this.logger.error('Failed to save user cache:', error);
        }
    }

    /** Throttled save user cache - Reduce frequent disk writes */
    saveUserCacheThrottled() {
        this.pendingSave = true;

        if (this.saveThrottleTimer) {
            clearTimeout(this.saveThrottleTimer);
        }

        this.saveThrottleTimer = setTimeout(async () => {
            if (this.pendingSave) {
                await this.saveUserCache();
                this.pendingSave = false;
                this.saveThrottleTimer = null;
            }
        }, this.saveThrottleDelay);
    }

    /** Force immediate save of user cache - Used for program exit scenarios */
    async forceUserCacheSave() {
        await this.saveAllUserData(this.users, this.startTime);
        if (this.saveThrottleTimer) {
            clearTimeout(this.saveThrottleTimer);
            this.saveThrottleTimer = null;
        }
        if (this.pendingSave) {
            await this.saveUserCache();
            this.pendingSave = false;
        }
    }

    /** Get or create user record
     * @param {number} uid - User ID
     * @returns {UserData} - User data instance
     */
    getUser(uid) {
        if (!this.users.has(uid)) {
            const user = new UserData(uid);

            // Set name and profession from cache
            const cachedData = this.userCache.get(String(uid));
            if (cachedData) {
                if (cachedData.name) {
                    user.setName(cachedData.name);
                }
                if (cachedData.profession) {
                    user.setProfession(cachedData.profession);
                }
                if (cachedData.fightPoint !== undefined && cachedData.fightPoint !== null) {
                    user.setFightPoint(cachedData.fightPoint);
                }
                if (cachedData.maxHp !== undefined && cachedData.maxHp !== null) {
                    user.setAttrKV('max_hp', cachedData.maxHp);
                }
            }
            if (this.hpCache.has(uid)) {
                user.setAttrKV('hp', this.hpCache.get(uid));
            }

            this.users.set(uid, user);
        }
        return this.users.get(uid);
    }

    /** Add damage record
     * @param {number} uid - User ID who dealt damage
     * @param {number} skillId - Skill ID/Buff ID
     * @param {string} element - Skill element attribute
     * @param {number} damage - Damage value
     * @param {boolean} isCrit - Whether it's a critical hit
     * @param {boolean} [isLucky] - Whether it's lucky
     * @param {boolean} [isCauseLucky] - Whether it causes lucky
     * @param {number} hpLessenValue - HP decrease amount
     * @param {number} targetUid - Damage target ID
     */
    addDamage(uid, skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue = 0, targetUid) {
        if (isPaused) return;
        if (globalSettings.onlyRecordEliteDummy && targetUid !== 75) return;
        this.checkTimeoutClear();
        const user = this.getUser(uid);
        user.addDamage(skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue);
    }

    /** Add healing record
     * @param {number} uid - User ID who performed healing
     * @param {number} skillId - Skill ID/Buff ID
     * @param {string} element - Skill element attribute
     * @param {number} healing - Healing value
     * @param {boolean} isCrit - Whether it's a critical hit
     * @param {boolean} [isLucky] - Whether it's lucky
     * @param {boolean} [isCauseLucky] - Whether it causes lucky
     * @param {number} targetUid - User ID being healed
     */
    addHealing(uid, skillId, element, healing, isCrit, isLucky, isCauseLucky, targetUid) {
        if (isPaused) return;
        this.checkTimeoutClear();
        if (uid !== 0) {
            const user = this.getUser(uid);
            user.addHealing(skillId, element, healing, isCrit, isLucky, isCauseLucky);
        }
    }

    /** Add taken damage record
     * @param {number} uid - User ID who took damage
     * @param {number} damage - Damage taken
     * @param {boolean} isDead - Whether it's fatal damage
     * */
    addTakenDamage(uid, damage, isDead) {
        if (isPaused) return;
        this.checkTimeoutClear();
        const user = this.getUser(uid);
        user.addTakenDamage(damage, isDead);
    }

    /** Add log record
     * @param {string} log - Log content
     * */
    async addLog(log) {
        if (isPaused) return;

        const logDir = path.join('./logs', String(this.startTime));
        const logFile = path.join(logDir, 'fight.log');
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${log}\n`;

        this.lastLogTime = Date.now();

        await this.logLock.acquire();
        try {
            if (!this.logDirExist.has(logDir)) {
                try {
                    await fsPromises.access(logDir);
                } catch (error) {
                    await fsPromises.mkdir(logDir, { recursive: true });
                }
                this.logDirExist.add(logDir);
            }
            await fsPromises.appendFile(logFile, logEntry, 'utf8');
        } catch (error) {
            this.logger.error('Failed to save log:', error);
        }
        this.logLock.release();
    }

    /** Set user profession
     * @param {number} uid - User ID
     * @param {string} profession - Profession name
     * */
    setProfession(uid, profession) {
        const user = this.getUser(uid);
        if (user.profession !== profession) {
            user.setProfession(profession);
            this.logger.info(`Found profession ${profession} for uid ${uid}`);

            // Update cache
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).profession = profession;
            this.saveUserCacheThrottled();
        }
    }

    /** Set user name
     * @param {number} uid - User ID
     * @param {string} name - Name
     * */
    setName(uid, name) {
        const user = this.getUser(uid);
        if (user.name !== name) {
            user.setName(name);
            this.logger.info(`Found player name ${name} for uid ${uid}`);

            // Update cache
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).name = name;
            this.saveUserCacheThrottled();
        }
    }

    /** Set user total fight point
     * @param {number} uid - User ID
     * @param {number} fightPoint - Total fight point
     */
    setFightPoint(uid, fightPoint) {
        const user = this.getUser(uid);
        if (user.fightPoint != fightPoint) {
            user.setFightPoint(fightPoint);
            this.logger.info(`Found fight point ${fightPoint} for uid ${uid}`);

            // Update cache
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).fightPoint = fightPoint;
            this.saveUserCacheThrottled();
        }
    }

    /** Set additional data
     * @param {number} uid - User ID
     * @param {string} key
     * @param {any} value
     */
    setAttrKV(uid, key, value) {
        const user = this.getUser(uid);
        user.attr[key] = value;

        if (key === 'max_hp') {
            // Update cache
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).maxHp = value;
            this.saveUserCacheThrottled();
        }
        if (key === 'hp') {
            this.hpCache.set(uid, value);
        }
    }

    /** Update real-time DPS and HPS for all users */
    updateAllRealtimeDps() {
        for (const user of this.users.values()) {
            user.updateRealtimeDps();
        }
    }

    /** Get user skill data */
    getUserSkillData(uid) {
        const user = this.users.get(uid);
        if (!user) return null;

        return {
            uid: user.uid,
            name: user.name,
            profession: user.profession + (user.subProfession ? `-${user.subProfession}` : ''),
            skills: user.getSkillSummary(),
            attr: user.attr,
        };
    }

    /** Get all user data */
    getAllUsersData() {
        const result = {};
        for (const [uid, user] of this.users.entries()) {
            result[uid] = user.getSummary();
        }
        return result;
    }

    /** Get all enemy cache data */
    getAllEnemiesData() {
        const result = {};
        const enemyIds = new Set([...this.enemyCache.name.keys(), ...this.enemyCache.hp.keys(), ...this.enemyCache.maxHp.keys()]);
        enemyIds.forEach((id) => {
            result[id] = {
                name: this.enemyCache.name.get(id),
                hp: this.enemyCache.hp.get(id),
                max_hp: this.enemyCache.maxHp.get(id),
            };
        });
        return result;
    }

    /** Remove enemy cache data */
    deleteEnemyData(id) {
        this.enemyCache.name.delete(id);
        this.enemyCache.hp.delete(id);
        this.enemyCache.maxHp.delete(id);
    }

    /** Clear enemy cache */
    refreshEnemyCache() {
        this.enemyCache.name.clear();
        this.enemyCache.hp.clear();
        this.enemyCache.maxHp.clear();
    }

    /** Clear all user data */
    clearAll() {
        const usersToSave = this.users;
        const saveStartTime = this.startTime;
        this.users = new Map();
        this.startTime = Date.now();
        this.lastAutoSaveTime = 0;
        this.lastLogTime = 0;
        this.saveAllUserData(usersToSave, saveStartTime);
    }

    /** Get user list */
    getUserIds() {
        return Array.from(this.users.keys());
    }

    /** Save all user data to history
     * @param {Map} usersToSave - User data Map to save
     * @param {number} startTime - Data start time
     */
    async saveAllUserData(usersToSave = null, startTime = null) {
        try {
            const endTime = Date.now();
            const users = usersToSave || this.users;
            const timestamp = startTime || this.startTime;
            const logDir = path.join('./logs', String(timestamp));
            const usersDir = path.join(logDir, 'users');
            const summary = {
                startTime: timestamp,
                endTime,
                duration: endTime - timestamp,
                userCount: users.size,
                version: VERSION,
                maxHpMonster: '',
            };

            let maxHpMonsterId = 0;
            for (const [id, hp] of this.enemyCache.maxHp.entries()) {
                if (!maxHpMonsterId || hp > this.enemyCache.maxHp.get(maxHpMonsterId)) {
                    maxHpMonsterId = id;
                }
            }
            if (maxHpMonsterId && this.enemyCache.name.has(maxHpMonsterId)) {
                summary.maxHpMonster = this.enemyCache.name.get(maxHpMonsterId);
            }

            const allUsersData = {};
            const userDatas = new Map();
            for (const [uid, user] of users.entries()) {
                allUsersData[uid] = user.getSummary();

                const userData = {
                    uid: user.uid,
                    name: user.name,
                    profession: user.profession + (user.subProfession ? `-${user.subProfession}` : ''),
                    skills: user.getSkillSummary(),
                    attr: user.attr,
                };
                userDatas.set(uid, userData);
            }

            try {
                await fsPromises.access(usersDir);
            } catch (error) {
                await fsPromises.mkdir(usersDir, { recursive: true });
            }

            // Save all user data summary
            const allUserDataPath = path.join(logDir, 'allUserData.json');
            await fsPromises.writeFile(allUserDataPath, JSON.stringify(allUsersData, null, 2), 'utf8');

            // Save detailed data for each user
            for (const [uid, userData] of userDatas.entries()) {
                const userDataPath = path.join(usersDir, `${uid}.json`);
                await fsPromises.writeFile(userDataPath, JSON.stringify(userData, null, 2), 'utf8');
            }

            await fsPromises.writeFile(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

            this.logger.debug(`Saved data for ${summary.userCount} users to ${logDir}`);
        } catch (error) {
            this.logger.error('Failed to save all user data:', error);
            throw error;
        }
    }

    checkTimeoutClear() {
        if (!globalSettings.autoClearOnTimeout || this.lastLogTime === 0 || this.users.size === 0) return;
        const currentTime = Date.now();
        if (this.lastLogTime && currentTime - this.lastLogTime > 15000) {
            this.clearAll();
            this.logger.info('Timeout reached, statistics cleared!');
        }
    }

    getGlobalSettings() {
        return globalSettings;
    }
}

async function main() {
    print('Welcome to use Damage Counter for Star Resonance!');
    print(`Version: V${VERSION}`);
    print('GitHub: https://github.com/dmlgzs/StarResonanceDamageCounter');
    for (let i = 0; i < devices.length; i++) {
        print(String(i).padStart(2, ' ') + '.' + (devices[i].description || devices[i].name));
    }

    // Get device number and log level from command line arguments
    const args = process.argv.slice(2);
    let num = args[0];
    let log_level = args[1];

    if (num === 'auto') {
        print('Auto detecting default network interface...');
        const device_num = await findDefaultNetworkDevice(devices);
        if (device_num) {
            num = device_num;
            print(`Using network interface: ${num} - ${devices[num].description}`);
        } else {
            print('Default network interface not found!');
            num = undefined;
        }
    }

    // Parameter validation function
    function isValidLogLevel(level) {
        return ['info', 'debug'].includes(level);
    }

    // If not passed via command line or invalid, use interactive mode
    while (num === undefined || !devices[num]) {
        num = await ask('Please enter the number of the device to capture: ');
        if (!num) {
            print('Auto detecting default network interface...');
            const device_num = await findDefaultNetworkDevice(devices);
            if (device_num) {
                num = device_num;
                print(`Using network interface: ${num} - ${devices[num].description}`);
            } else {
                print('Default network interface not found!');
                num = undefined;
            }
        }
        if (!devices[num]) {
            print('Cannot find device ' + num + '!');
        }
    }
    while (log_level === undefined || !isValidLogLevel(log_level)) {
        log_level = (await ask('Please enter log level (info|debug): ')) || 'info';
        if (!isValidLogLevel(log_level)) {
            print('Invalid log level!');
        }
    }

    rl.close();
    const logger = winston.createLogger({
        level: log_level,
        format: winston.format.combine(
            winston.format.colorize({ all: true }),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf((info) => {
                return `[${info.timestamp}] [${info.level}] ${info.message}`;
            }),
        ),
        transports: [new winston.transports.Console()],
    });

    const userDataManager = new UserDataManager(logger);

    // Asynchronously initialize user data manager
    await userDataManager.initialize();

    // Save user cache when process exits
    process.on('SIGINT', async () => {
        console.log('\nSaving user cache...');
        await userDataManager.forceUserCacheSave();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\nSaving user cache...');
        await userDataManager.forceUserCacheSave();
        process.exit(0);
    });

    // Real-time DPS update
    setInterval(() => {
        if (!isPaused) {
            userDataManager.updateAllRealtimeDps();
        }
    }, 100);

    // Express and Socket.io setup
    app.use(cors());
    app.use(express.json()); // Parse JSON request body
    app.use(express.static(path.join(__dirname, 'public'))); // Static file service
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
    });

    app.get('/api/data', (req, res) => {
        const userData = userDataManager.getAllUsersData();
        const enemiesData = userDataManager.getAllEnemiesData();
        const data = {
            code: 0,
            user: userData,
            enemy: enemiesData,
        };
        res.json(data);
    });

    app.get('/api/enemies', (req, res) => {
        const enemiesData = userDataManager.getAllEnemiesData();
        const data = {
            code: 0,
            enemy: enemiesData,
        };
        res.json(data);
    });

    app.get('/api/clear', (req, res) => {
        userDataManager.clearAll();
        logger.info('Statistics have been cleared!');
        res.json({
            code: 0,
            msg: 'Statistics have been cleared!',
        });
    });

    // Pause/Resume statistics API
    app.post('/api/pause', (req, res) => {
        const { paused } = req.body;
        isPaused = paused;
        logger.info(`Statistics ${isPaused ? 'paused' : 'resumed'}!`);
        res.json({
            code: 0,
            msg: `Statistics ${isPaused ? 'paused' : 'resumed'}!`,
            paused: isPaused,
        });
    });

    // Get pause status API
    app.get('/api/pause', (req, res) => {
        res.json({
            code: 0,
            paused: isPaused,
        });
    });

    // Get skill data
    app.get('/api/skill/:uid', (req, res) => {
        const uid = parseInt(req.params.uid);
        const skillData = userDataManager.getUserSkillData(uid);

        if (!skillData) {
            return res.status(404).json({
                code: 1,
                msg: 'User not found',
            });
        }

        res.json({
            code: 0,
            data: skillData,
        });
    });

    // History data overview
    app.get('/api/history/:timestamp/summary', async (req, res) => {
        const { timestamp } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'summary.json');

        try {
            const data = await fsPromises.readFile(historyFilePath, 'utf8');
            const summaryData = JSON.parse(data);
            res.json({
                code: 0,
                data: summaryData,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History summary file not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History summary file not found',
                });
            } else {
                logger.error('Failed to read history summary file:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to read history summary file',
                });
            }
        }
    });

    // History data
    app.get('/api/history/:timestamp/data', async (req, res) => {
        const { timestamp } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'allUserData.json');

        try {
            const data = await fsPromises.readFile(historyFilePath, 'utf8');
            const userData = JSON.parse(data);
            res.json({
                code: 0,
                user: userData,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History data file not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History data file not found',
                });
            } else {
                logger.error('Failed to read history data file:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to read history data file',
                });
            }
        }
    });

    // Get history skill data
    app.get('/api/history/:timestamp/skill/:uid', async (req, res) => {
        const { timestamp, uid } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'users', `${uid}.json`);

        try {
            const data = await fsPromises.readFile(historyFilePath, 'utf8');
            const skillData = JSON.parse(data);
            res.json({
                code: 0,
                data: skillData,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History skill file not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History skill file not found',
                });
            } else {
                logger.error('Failed to read history skill file:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to read history skill file',
                });
            }
        }
    });

    // Download history battle log data
    app.get('/api/history/:timestamp/download', async (req, res) => {
        const { timestamp } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'fight.log');
        res.download(historyFilePath, `fight_${timestamp}.log`);
    });

    // History data list
    app.get('/api/history/list', async (req, res) => {
        try {
            const data = (await fsPromises.readdir('./logs', { withFileTypes: true }))
                .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
                .map((e) => e.name);
            res.json({
                code: 0,
                data: data,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History path not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History path not found',
                });
            } else {
                logger.error('Failed to load history path:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to load history path',
                });
            }
        }
    });

    // Settings related endpoints
    app.get('/api/settings', async (req, res) => {
        res.json({ code: 0, data: globalSettings });
    });

    app.post('/api/settings', async (req, res) => {
        const newSettings = req.body;
        globalSettings = { ...globalSettings, ...newSettings };
        await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(globalSettings, null, 2), 'utf8');
        res.json({ code: 0, data: globalSettings });
    });

    try {
        await fsPromises.access(SETTINGS_PATH);
        const data = await fsPromises.readFile(SETTINGS_PATH, 'utf8');
        globalSettings = { ...globalSettings, ...JSON.parse(data) };
    } catch (e) {
        if (e.code !== 'ENOENT') {
            logger.error('Failed to load settings:', e);
        }
    }

    const clearDataOnServerChange = () => {
        userDataManager.refreshEnemyCache();
        if (!globalSettings.autoClearOnServerChange || userDataManager.lastLogTime === 0 || userDataManager.users.size === 0) return;
        userDataManager.clearAll();
        logger.info('Server changed, statistics cleared!');
    };

    // WebSocket connection handling
    io.on('connection', (socket) => {
        logger.info('WebSocket client connected: ' + socket.id);

        socket.on('disconnect', () => {
            logger.info('WebSocket client disconnected: ' + socket.id);
        });
    });

    // Broadcast data to all WebSocket clients every 100ms
    setInterval(() => {
        if (!isPaused) {
            const userData = userDataManager.getAllUsersData();
            const enemiesData = userDataManager.getAllEnemiesData();
            const data = {
                code: 0,
                user: userData,
                enemy: enemiesData,
            };
            io.emit('data', data);
        }
    }, 100);

    const checkPort = (port) => {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port);
        });
    };
    let server_port = 8989;
    while (true) {
        if (await checkPort(server_port)) break;
        logger.warn(`port ${server_port} is already in use`);
        server_port++;
    }
    server.listen(server_port, () => {
        // Automatically open webpage with default browser (cross-platform compatible)
        const url = 'http://localhost:' + server_port;
        logger.info(`Web Server started at ${url}`);
        logger.info('WebSocket Server started');

        let command;
        switch (process.platform) {
            case 'darwin': // macOS
                command = `open ${url}`;
                break;
            case 'win32': // Windows
                command = `start ${url}`;
                break;
            default: // Linux and other Unix-like systems
                command = `xdg-open ${url}`;
                break;
        }

        exec(command, (error) => {
            if (error) {
                logger.error(`Failed to open browser: ${error.message}`);
            }
        });
    });

    logger.info('Welcome!');
    logger.info('Attempting to find the game server, please wait!');

    let current_server = '';
    let _data = Buffer.alloc(0);
    let tcp_next_seq = -1;
    let tcp_cache = new Map();
    let tcp_last_time = 0;
    const tcp_lock = new Lock();

    const clearTcpCache = () => {
        _data = Buffer.alloc(0);
        tcp_next_seq = -1;
        tcp_last_time = 0;
        tcp_cache.clear();
    };

    const fragmentIpCache = new Map();
    const FRAGMENT_TIMEOUT = 30000;
    const getTCPPacket = (frameBuffer, ethOffset) => {
        const ipPacket = decoders.IPV4(frameBuffer, ethOffset);
        const ipId = ipPacket.info.id;
        const isFragment = (ipPacket.info.flags & 0x1) !== 0;
        const _key = `${ipId}-${ipPacket.info.srcaddr}-${ipPacket.info.dstaddr}-${ipPacket.info.protocol}`;
        const now = Date.now();

        if (isFragment || ipPacket.info.fragoffset > 0) {
            if (!fragmentIpCache.has(_key)) {
                fragmentIpCache.set(_key, {
                    fragments: [],
                    timestamp: now,
                });
            }

            const cacheEntry = fragmentIpCache.get(_key);
            const ipBuffer = Buffer.from(frameBuffer.subarray(ethOffset));
            cacheEntry.fragments.push(ipBuffer);
            cacheEntry.timestamp = now;

            // there's more fragment ip packetm, wait for the rest
            if (isFragment) {
                return null;
            }

            // last fragment received, reassemble
            const fragments = cacheEntry.fragments;
            if (!fragments) {
                logger.error(`Can't find fragments for ${_key}`);
                return null;
            }

            // Reassemble fragments based on their offset
            let totalLength = 0;
            const fragmentData = [];

            // Collect fragment data with their offsets
            for (const buffer of fragments) {
                const ip = decoders.IPV4(buffer);
                const fragmentOffset = ip.info.fragoffset * 8;
                const payloadLength = ip.info.totallen - ip.hdrlen;
                const payload = Buffer.from(buffer.subarray(ip.offset, ip.offset + payloadLength));

                fragmentData.push({
                    offset: fragmentOffset,
                    payload: payload,
                });

                const endOffset = fragmentOffset + payloadLength;
                if (endOffset > totalLength) {
                    totalLength = endOffset;
                }
            }

            const fullPayload = Buffer.alloc(totalLength);
            for (const fragment of fragmentData) {
                fragment.payload.copy(fullPayload, fragment.offset);
            }

            fragmentIpCache.delete(_key);
            return fullPayload;
        }

        return Buffer.from(frameBuffer.subarray(ipPacket.offset, ipPacket.offset + (ipPacket.info.totallen - ipPacket.hdrlen)));
    };

    // Packet capture related
    const eth_queue = [];
    const c = new Cap();
    const device = devices[num].name;
    const filter = 'ip and tcp';
    const bufSize = 10 * 1024 * 1024;
    const buffer = Buffer.alloc(65535);
    const linkType = c.open(device, filter, bufSize, buffer);
    const supportedLinkType = ['ETHERNET', 'NULL', 'LINKTYPE_LINUX_SLL'];
    if (!supportedLinkType.includes(linkType)) {
        logger.error('The device seems to be WRONG! Please check the device! Device type: ' + linkType);
    }
    c.setMinBytes && c.setMinBytes(0);
    c.on('packet', async function (nbytes, trunc) {
        eth_queue.push(Buffer.from(buffer.subarray(0, nbytes)));
    });
    const processEthPacket = async (frameBuffer) => {
        // logger.debug('packet: length ' + nbytes + ' bytes, truncated? ' + (trunc ? 'yes' : 'no'));

        let ethPacket;
        if (linkType === 'ETHERNET') {
            ethPacket = decoders.Ethernet(frameBuffer);
        } else if (linkType === 'NULL') {
            ethPacket = {
                info: {
                    dstmac: '44:69:6d:6f:6c:65',
                    srcmac: '44:69:6d:6f:6c:65',
                    type: frameBuffer.readUInt32LE() === 2 ? 2048 : 75219598273637n,
                    vlan: undefined,
                    length: undefined,
                },
                offset: 4,
            };
        } else if (linkType === 'LINKTYPE_LINUX_SLL') {
            ethPacket = {
                info: {
                    dstmac: '44:69:6d:6f:6c:65',
                    srcmac: '44:69:6d:6f:6c:65',
                    type: frameBuffer.readUInt32BE(14) === 0x0800 ? 2048 : 75219598273637n,
                    vlan: undefined,
                    length: undefined,
                },
                offset: 16,
            };
        }

        if (ethPacket.info.type !== PROTOCOL.ETHERNET.IPV4) return;

        const ipPacket = decoders.IPV4(frameBuffer, ethPacket.offset);
        const srcaddr = ipPacket.info.srcaddr;
        const dstaddr = ipPacket.info.dstaddr;

        const tcpBuffer = getTCPPacket(frameBuffer, ethPacket.offset);
        if (tcpBuffer === null) return;
        const tcpPacket = decoders.TCP(tcpBuffer);

        const buf = Buffer.from(tcpBuffer.subarray(tcpPacket.hdrlen));

        //logger.debug(' from port: ' + tcpPacket.info.srcport + ' to port: ' + tcpPacket.info.dstport);
        const srcport = tcpPacket.info.srcport;
        const dstport = tcpPacket.info.dstport;
        const src_server = srcaddr + ':' + srcport + ' -> ' + dstaddr + ':' + dstport;
        const src_server_re = dstaddr + ':' + dstport + ' -> ' + srcaddr + ':' + srcport;

        await tcp_lock.acquire();
        if (current_server !== src_server && current_server !== src_server_re) {
            try {
                // Try to identify server through small packets
                if (buf[4] == 0 && buf[5] == 6) {
                    const data = buf.subarray(10);
                    if (data.length) {
                        const stream = Readable.from(data, { objectMode: false });
                        let data1;
                        do {
                            const len_buf = stream.read(4);
                            if (!len_buf) break;
                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                            const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]); //c3SB??
                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                            try {
                                if (current_server !== src_server) {
                                    current_server = src_server;
                                    clearTcpCache();
                                    tcp_next_seq = tcpPacket.info.seqno + buf.length;
                                    clearDataOnServerChange();
                                    logger.info('Got Scene Server Address by FrameDown Notify Packet: ' + src_server);
                                }
                            } catch (e) {}
                        } while (data1 && data1.length);
                    }
                }
            } catch (e) {}
            try {
                // Try to identify server through login return packet (still needs testing)
                if (buf.length === 0x62) {
                    // prettier-ignore
                    const signature = Buffer.from([
                        0x00, 0x00, 0x00, 0x62,
                        0x00, 0x03,
                        0x00, 0x00, 0x00, 0x01,
                        0x00, 0x11, 0x45, 0x14,//seq?
                        0x00, 0x00, 0x00, 0x00,
                        0x0a, 0x4e, 0x08, 0x01, 0x22, 0x24
                    ]);
                    if (
                        Buffer.compare(buf.subarray(0, 10), signature.subarray(0, 10)) === 0 &&
                        Buffer.compare(buf.subarray(14, 14 + 6), signature.subarray(14, 14 + 6)) === 0
                    ) {
                        if (current_server !== src_server) {
                            current_server = src_server;
                            clearTcpCache();
                            tcp_next_seq = tcpPacket.info.seqno + buf.length;
                            clearDataOnServerChange();
                            logger.info('Got Scene Server Address by Login Return Packet: ' + src_server);
                        }
                    }
                }
            } catch (e) {}
            try {
                // Try to identify server through a reported small packet
                if (buf[4] == 0 && buf[5] == 5) {
                    const data = buf.subarray(10);
                    if (data.length) {
                        const stream = Readable.from(data, { objectMode: false });
                        let data1;
                        do {
                            const len_buf = stream.read(4);
                            if (!len_buf) break;
                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                            const signature = Buffer.from([0x00, 0x06, 0x26, 0xad, 0x66, 0x00]);
                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                            try {
                                if (current_server !== src_server_re) {
                                    current_server = src_server_re;
                                    clearTcpCache();
                                    tcp_next_seq = tcpPacket.info.ackno;
                                    clearDataOnServerChange();
                                    logger.info('Got Scene Server Address by FrameUp Notify Packet: ' + src_server_re);
                                }
                            } catch (e) {}
                        } while (data1 && data1.length);
                    }
                }
            } catch (e) {}
            tcp_lock.release();
            return;
        }
        // logger.debug(`packet seq ${tcpPacket.info.seqno >>> 0} size ${buf.length} expected next seq ${((tcpPacket.info.seqno >>> 0) + buf.length) >>> 0}`);
        // This is already a packet from the identified server
        if (tcp_next_seq === -1) {
            logger.error('Unexpected TCP capture error! tcp_next_seq is -1');
            if (buf.length > 4 && buf.readUInt32BE() < 0x0fffff) {
                tcp_next_seq = tcpPacket.info.seqno;
            }
        }
        // logger.debug('TCP next seq: ' + tcp_next_seq);
        if ((tcp_next_seq - tcpPacket.info.seqno) << 0 <= 0 || tcp_next_seq === -1) {
            tcp_cache.set(tcpPacket.info.seqno, buf);
        }
        while (tcp_cache.has(tcp_next_seq)) {
            const seq = tcp_next_seq;
            const cachedTcpData = tcp_cache.get(seq);
            _data = _data.length === 0 ? cachedTcpData : Buffer.concat([_data, cachedTcpData]);
            tcp_next_seq = (seq + cachedTcpData.length) >>> 0; //uint32
            tcp_cache.delete(seq);
            tcp_last_time = Date.now();
        }

        while (_data.length > 4) {
            let packetSize = _data.readUInt32BE();

            if (_data.length < packetSize) break;

            if (_data.length >= packetSize) {
                const packet = _data.subarray(0, packetSize);
                _data = _data.subarray(packetSize);
                const processor = new PacketProcessor({ logger, userDataManager });
                processor.processPacket(packet);
            } else if (packetSize > 0x0fffff) {
                logger.error(`Invalid Length!! ${_data.length},${len},${_data.toString('hex')},${tcp_next_seq}`);
                process.exit(1);
                break;
            }
        }
        tcp_lock.release();
    };
    (async () => {
        while (true) {
            if (eth_queue.length) {
                const pkt = eth_queue.shift();
                processEthPacket(pkt);
            } else {
                await new Promise((r) => setTimeout(r, 1));
            }
        }
    })();

    // Regularly clear expired IP fragment cache
    setInterval(async () => {
        const now = Date.now();
        let clearedFragments = 0;
        for (const [key, cacheEntry] of fragmentIpCache) {
            if (now - cacheEntry.timestamp > FRAGMENT_TIMEOUT) {
                fragmentIpCache.delete(key);
                clearedFragments++;
            }
        }
        if (clearedFragments > 0) {
            logger.debug(`Cleared ${clearedFragments} expired IP fragment caches`);
        }

        if (tcp_last_time && Date.now() - tcp_last_time > FRAGMENT_TIMEOUT) {
            logger.warn('Cannot capture the next packet! Is the game closed or disconnected? seq: ' + tcp_next_seq);
            current_server = '';
            clearTcpCache();
        }
    }, 10000);
}

if (!zlib.zstdDecompressSync) {
    // Previously, some people always used old versions of Node.js, ignored warnings and still complained about inaccurate data, now we simply don't allow old versions to be used
    // Some people also write closed-source code based on open-source code, not only do they not comply with the license, but they also disparage open-source, what kind of people are these
    warnAndExit('zstdDecompressSync is not available! Please update your Node.js!');
}

main();
