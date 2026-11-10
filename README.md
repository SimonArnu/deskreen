# Deskreen CE (Community Edition)

![platform](https://img.shields.io/badge/platform-Ubuntu-lightgrey)
(Over 2M downloads during 5 years since launch)

![Deskreen Logo](https://raw.githubusercontent.com/pavlobu/deskreen/master/resources/icon.png)

## Deskreen turns any device with a web browser into a secondary screen for your computer

## To learn more visit our website: [deskreen.com](https://deskreen.com)

## [Donate to support Deskreen Open-Source](https://deskreen.com/#contribute)

Deskreen is an `electron.js` based application that uses `WebRTC` to make a live stream of your computer screen to a web browser on any device. This fork targets Ubuntu.
The current open-source Community Edition version has limited features. If you need more features please consider upgrading to [Pro](https://deskreen.com/download) version for more features when it is released.

---

### ▶️ [See how people use Deskreen on Youtube](https://www.youtube.com/results?search_query=deskreen) (video tutorials, demos, use cases for Deskreen day to day usage)

---

## [Deskreen Frequently Asked Questions](https://deskreen.com/faq)

---

### Prerequisites

On Ubuntu, install `node>=v23`, `npm>=10`, OpenSSL, `flock`, `gdbus`, and a
running Avahi daemon. The application uses Avahi's `.local` hostname.


1. git clone this repo
2. `npm i`
3. `cd ./src/client-viewer && npm i && cd ../..`
4. `npm run clean && npm run build && npm run start` -- run in prod like mode

#### for more npm scripts look at `package.json`

## Starting with a Custom Port

To choose the HTTPS server port, pass `--port` followed by a number between
1 and 65535. If that port is already in use, Deskreen exits instead of choosing
a different port. This does not restrict WebRTC media ports.

```bash
deskreen-ce --port 8443
```

## HTTPS setup

The app creates a private certificate authority on first launch. Before using
the viewer, transfer **only the public `ca.crt` certificate** shown in the app
to the viewing device through a trusted channel, verify its SHA-256 fingerprint,
and install it in a trust store used by the browser. Android browser support for
user-installed CAs varies. Installing a CA grants it broad trust on the device;
never share `ca.key` or any other private key. The app does not install the CA
automatically.

If the CA private key may have been exposed, stop sharing and remove the CA from
each viewing device's trust store. A replacement CA must be distributed and
verified again; the app does not silently replace an existing CA.

The QR code uses Avahi's `.local` hostname, which requires mDNS to work between
the devices. A hostname change renews the server certificate without replacing
the CA. If certificate initialization is interrupted, preserve existing CA
files and inspect the reported error before attempting recovery.

## Tests

Run `npm test` for the automated tests. `npm run test:viewer` builds and tests
the browser viewer with Chrome; set `CHROME_BIN` if Chrome is installed at a
different path. After `npm run build`, `npm run test:desktop` and
`npm run test:app` exercise Electron and the full HTTPS signaling application.
The desktop tests require a graphical session and a working Electron sandbox;
the application test also requires Avahi and `gdbus`.
`npm run test:firefox` additionally requires Firefox, geckodriver and NSS
`certutil`; set `GECKODRIVER` and `CERTUTIL` if they are not on the PATH.
For Snap Firefox, set `FIREFOX_PROFILE_ROOT="$HOME/snap/firefox/common"` so
the isolated test profiles are accessible inside the Snap.

## Maintainer

- [Pavlo (Paul) Buidenkov](https://www.linkedin.com/in/pavlobu)

## License

AGPL-3.0 License © [Pavlo (Paul) Buidenkov](https://github.com/pavlobu/deskreen)

## Copyright

Electron-Vite MIT License © [electron-vite](https://github.com/alex8088/electron-vite)

React MIT License © [Facebook, Inc. and its affiliates](https://github.com/facebook/react)

Vite MIT License © [Vite.js](https://github.com/vitejs/vite)

Electron Builder MIT License © [electron-builder contributors](https://github.com/electron-userland/electron-builder)

Apache 2.0 © [blueprintjs](https://github.com/palantir/blueprint)

simple-peer MIT. Copyright © [Feross Aboukhadijeh](http://feross.org/)

tweetnacl ISC License © Dmitry Chestnykh, Devi Mandiri, and contributors (https://github.com/dchest/tweetnacl-js)

darkwire.io MIT License © [darkwire/darkwire.io](https://github.com/darkwire/darkwire.io)

And many many others...

## Thanks

🙏 Many thanks to all 🌍 open source community members and maintainers of libraries used in this project.
