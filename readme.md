# SquareDesk Studio

A local dashboard for scraping Binance Square, generating AI articles, and publishing them through isolated Playwright browser profiles.

## Prerequisites

Before you begin, ensure you have the following installed:
- **Node.js** (v22.13.0 or higher) — [Download here](https://nodejs.org/)
- **Git** (optional, for cloning)
- **Yarn** (Package Manager)

---

## 1. Installation

Open your terminal (or Command Prompt/PowerShell on Windows) and navigate to the project folder:

```bash
cd squaredesk-studio

##Install Yarn Globally
##If you don't have Yarn installed:

##Kali Linux / macOS: 
sudo npm install -g yarn

##Windows:
 npm install -g yarn

##Install Dependencies either window or kal the same thing

yarn install

Install Playwright Browsers
The app uses Playwright to control a real Chromium browser. You must download the browser binaries and system dependencies.

##On Kali Linux:
yarn playwright install chromium

# If you get missing library errors, run:
sudo yarn playwright install-deps chromium

##On Windows:##powershell/cmd
yarn playwright install chromium

##chose any free port/ i chose 3001
## run the app on port 3001 to avoid conflicts:
##in you command shell run
PORT=3001 yarn dev

#On Windows PowerShell, use 
$env:PORT=3001; yarn dev