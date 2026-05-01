# RESTO PRO Backend Setup

This package converts your single-computer HTML app into a central-server restaurant system.

## What changed

- The app is now served from a Node.js backend.
- Data is saved centrally in `resto.sqlite`, not each browser's `localStorage`.
- Kitchen, bar, cashier, waiter, and manager computers sync through Socket.IO live updates.
- Login uses backend authentication with hashed passwords.
- Receipt OCR upload now goes to `/api/ocr` on the server. Image OCR uses Tesseract when available; PDF files can still be saved manually after upload.

## Default login

```text
Email: owner@resto.com
Password: owner123
```

Change this password immediately from Settings > Accounts.

## Run on the main restaurant computer

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Open on the main computer:

```text
http://localhost:3000
```

## Connect kitchen/bar/cashier computers on the same Wi-Fi/LAN

1. Find the main computer IP address.

Windows:

```bash
ipconfig
```

Look for IPv4, for example:

```text
192.168.1.10
```

2. On kitchen/bar/cashier computers, open:

```text
http://192.168.1.10:3000
```

Use different accounts/roles:

```text
Owner/Admin  -> full access
Manager      -> management features
Waiter       -> tables, orders, invoices
Chef         -> kitchen screen only
Bar Staff    -> bar screen only
```

## Files

```text
server.js              Backend API + Socket.IO + SQLite
public/index.html      Your patched frontend
resto.sqlite           Created automatically when server starts
.env.example           Config template
package.json           Node dependencies
```

## Important notes

- Keep the main computer/server turned on while the restaurant is operating.
- All other computers must open the app from the server URL, not by double-clicking the HTML file.
- For production, change `JWT_SECRET` in `.env`.
- If Windows Firewall asks, allow Node.js on Private Network.
- Back up `resto.sqlite` regularly.

## API summary

```text
POST /api/login          Login
GET  /api/bootstrap      Load central state
GET  /api/state/:key     Read data section
POST /api/state/:key     Save data section and broadcast update
POST /api/ocr            Upload receipt image for OCR
GET  /api/health         Server health check
```
