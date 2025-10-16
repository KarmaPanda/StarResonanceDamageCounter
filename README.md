# Blue Protocol: Star Resonance Real-time Combat Data Counter

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-brightgreen.svg)](https://www.gnu.org/licenses/agpl-3.txt)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.13.1-orange.svg)](https://pnpm.io/)

A real-time combat data statistics tool for the "Blue Protocol: Star Resonance" game, which analyzes combat data in real-time through network packet capture technology, providing damage statistics, DPS calculations, and other features.

The accuracy of this tool has been verified through multiple actual combat tests, and no data loss issues have been found under stable network conditions.

This tool does not require modification of the game client and does not violate the game's terms of service. The tool aims to help players better understand combat data, reduce ineffective improvements, and enhance gaming experience. Before using this tool, please ensure that the data results will not be used for combat power discrimination or other behaviors that damage the game community environment.

[Introduction Video](https://www.bilibili.com/video/BV1T4hGzGEeX/)

This project has been translated with some degree of error. There are still a few aspects of the project that have not been translated, such as monster names, which can be modified in monsters_name_en.json if you would like to contribute.

## ✨ Features

- 🎯 **Real-time Damage Statistics** - Real-time capture and statistics of combat damage data
- 📊 **DPS Calculation** - Provides instantaneous DPS and overall DPS calculations
- 🎲 **Detailed Classification** - Distinguishes between normal damage, critical damage, lucky damage, and other types
- 🌐 **Web Interface** - Provides a beautiful real-time data display interface with line charts
- 🌙 **Theme Switching** - Supports day/night mode switching
- 🔄 **Auto Refresh** - Data updates in real-time without manual refresh
- 📈 **Statistical Analysis** - Detailed statistics such as critical hit rate and lucky rate

## 🚀 Quick Start

### One-Click Usage

Go to [Release page](https://github.com/KarmaPanda/StarResonanceDamageCounter/releases) to download the release version.

### Manual Compilation

#### Prerequisites

- **Node.js** >= 22.15.0
- **pnpm** >= 10.13.1
- **WinPcap/Npcap** (Network packet capture driver)
- **Visual Studio Build Tools** (Compilation dependency)
  - Can be installed through [Visual Studio Installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  - Select "C++ build tools" workload
- **Python** 3.10 (Compilation dependency)
  - Can be downloaded and installed from [Python official website](https://www.python.org/downloads/)
  - Ensure Python is added to system PATH

#### Installation Steps

1. **Clone Repository**

   ```bash
   git clone https://github.com/dmlgzs/StarResonanceDamageCounter.git
   cd StarResonanceDamageCounter
   ```

2. **Install Dependencies**

   ```bash
   corepack enable
   pnpm install
   ```

3. **Install WinPcap/Npcap**
   - Download and install [Npcap](https://nmap.org/npcap/) or [WinPcap](https://www.winpcap.org/) (Npcap recommended)
   - Ensure "WinPcap API-compatible mode" is selected during installation

4. **Run**

   ```bash
   node server.js
   ```

   After running, you will be prompted to:
   - Select the network device for packet capture (you can check network adapter information through Control Panel)
   - Select log level (`info`: basic information, `debug`: detailed logs)

   You can also specify directly through command line parameters:

   ```bash
   node server.js <device_number> <log_level>
   ```

   Or use auto-detection mode (recommended):

   ```bash
   node server.js auto info
   ```

   Auto-detection mode will:
   - Intelligently identify physical network adapters, excluding virtual adapters (such as ZeroTier, VMware, etc.)
   - Analyze network traffic for 3 seconds and automatically select the most active adapter
   - Fall back to routing table method when no traffic is detected

   Manual specification example:

   ```bash
   node server.js 4 info
   ```

### Usage Instructions

1. **Select Network Device**
   - After starting the program, a list of available network devices will be displayed
   - Enter the corresponding device number shown in the program output list (usually select the main network adapter)
   - You can check the network adapter information through Control Panel or system settings

2. **Set Log Level**
   - Choose log level: `info` or `debug`
   - Recommended to use `info` level to reduce log output

3. **Start Game**
   - The program will automatically detect game server connections
   - When a game server is detected, server information will be output and data statistics will begin

4. **View Data**
   - Open browser and visit: `http://localhost:8989`
   - View real-time combat data statistics

## 📱 Web Interface Features

### Data Display

- **Character ID** - Player character identifier
- **Total Damage/Healing** - Cumulative total damage/healing dealt
- **Damage Classification** - Detailed categories like pure critical, pure lucky, critical lucky, etc.
- **Critical Rate/Lucky Rate** - Critical hit and lucky trigger probability in combat
- **Instantaneous DPS/HPS** - Current second's damage/healing output
- **Maximum Instantaneous** - Historical highest instantaneous output record
- **Total DPS/HPS** - Overall average output efficiency

### Operation Features

- **Clear Data** - Reset all statistical data
- **Theme Switch** - Switch between day/night modes
- **Auto Refresh** - Automatically update data every 100ms

## 🛠️ Technical Architecture

### Core Dependencies

- **[cap](https://github.com/mscdex/cap)** - Network packet capture
- **[express](https://expressjs.com/)** - Web server framework
- **[protobufjs](https://github.com/protobufjs/protobuf.js)** - Protocol Buffers parsing
- **[winston](https://github.com/winstonjs/winston)** - Log management

## 📡 API Endpoints

### GET /api/data

Get real-time combat data statistics

**Response Example:**

```json
{
  "code": 0,
  "user": {
    "114514": {
      "realtime_dps": 0,
      "realtime_dps_max": 3342,
      "total_dps": 451.970764813365,
      "total_damage": {
        "normal": 9411,
        "critical": 246,
        "lucky": 732,
        "crit_lucky": 0,
        "hpLessen": 8956,
        "total": 10389
      },
      "total_count": {
        "normal": 76,
        "critical": 5,
        "lucky": 1,
        "total": 82
      },
      "realtime_hps": 4017,
      "realtime_hps_max": 11810,
      "total_hps": 4497.79970662755,
      "total_healing": {
        "normal": 115924,
        "critical": 18992,
        "lucky": 0,
        "crit_lucky": 0,
        "hpLessen": 0,
        "total": 134916
      },
      "taken_damage": 65,
      "profession": "愈合"
    }
  },
  "enemy": {
    "15395": {
      "name": "雷电食人魔",
      "hp": 18011262,
      "max_hp": 18011262
    }
  }
}
```

### GET /api/clear

Clear all statistical data

**Response Example:**

```json
{
  "code": 0,
  "msg": "Statistics have been cleared!"
}
```

### GET /api/enemies

Get enemy data

**Response Example:**

```json
{
  "code": 0,
  "enemy": {
    "15395": {
      "name": "雷电食人魔",
      "hp": 18011262,
      "max_hp": 18011262
    }
  }
}
```

## Other APIs can be viewed in the [source code](server.js)

## 🔧 Troubleshooting

### Common Issues

1. **Cannot detect game server**
   - Check if network device selection is correct
   - Confirm the game is running and connected to server
   - Try going to less crowded areas on the same map

2. **Web interface cannot be accessed**
   - Check if port 8989 is occupied
   - Confirm firewall settings allow local connections

3. **Data statistics abnormal**
   - Check log output for error messages
   - Try restarting the program to recapture

4. **cap module compilation error**
   - Ensure Visual Studio Build Tools and Python are installed
   - Confirm Node.js version meets requirements

5. **Program exits immediately after startup**
   - Ensure Npcap is installed
   - Confirm network device selection entered correct number

## 📄 License

[![](https://www.gnu.org/graphics/agplv3-with-text-162x68.png)](LICENSE)

This project is licensed under [GNU AFFERO GENERAL PUBLIC LICENSE version 3](LICENSE).

Using this project indicates that you agree to comply with the terms of this license.

### Derivative Software Related

- If you modify the source code and redistribute it, you must prominently credit this project.
- If you reference internal implementations (such as server identification, protocol parsing, data processing, etc.) to publish another project, you must prominently credit this project.

If you do not agree with this license and additional terms, please do not use this project or view the related code.

## 👥 Contributing

Welcome to submit Issues and Pull Requests to improve the project!

### Contributors

[![Contributors](https://contrib.rocks/image?repo=KarmaPanda/StarResonanceDamageCounter)](https://github.com/KarmaPanda/StarResonanceDamageCounter/graphs/contributors "Contributors")


### Additional Note

This project has been forked and translated by [KarmaPanda](https://github.com/KarmaPanda). Most of the code remains original to the 3.31 release of the original program, with slight modifications for translation & QOL purposes.

## ⭐ Support

If this project is helpful to you, please give it a Star ⭐

---

**Disclaimer**: This tool is for game data analysis and learning purposes only, and must not be used for any behavior that violates the game's terms of service. Users must bear the related risks themselves. The project developers are not responsible for any malicious combat power discrimination behavior by others using this tool. Please ensure compliance with relevant regulations and moral standards of the gaming community before use.
