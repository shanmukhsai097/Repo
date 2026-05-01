# RESTO PRO Cloud Web Setup

This is the cloud-ready version. All restaurant computers open one website URL. Data is stored on the cloud service disk, not inside each browser.

## Recommended simple deployment: Render

### 1. Create a GitHub repository
Upload the contents of this `backend` folder to a GitHub repo. `server.js` and `package.json` must be at the repo root.

### 2. Create Render Web Service
- New → Web Service
- Connect your GitHub repo
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

### 3. Add persistent disk

```text
Name: resto-data
Mount Path: /var/data
Size: 1 GB
```

### 4. Add environment variables

```text
NODE_VERSION=20
JWT_SECRET=<long random secret>
DATA_DIR=/var/data
DATA_FILE=/var/data/resto-data.json
UPLOAD_DIR=/var/data/uploads
OCR_ENABLED=true
```

### 5. Open your app
Render gives you a URL like:

```text
https://resto-pro.onrender.com
```

Use this same URL on kitchen, bar, cashier, and manager computers.

## Default login

```text
owner@resto.com
owner123
```

Change the password immediately after first login.

## Important

- Do not open the HTML file directly. Always open the cloud URL.
- Without a persistent disk or external database, cloud file data can disappear after redeploy/restart.
- For higher production reliability, move from JSON file storage to PostgreSQL.
