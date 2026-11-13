# Remaining work

## Trusted viewing devices

- [x] Allow an explicitly approved browser to be remembered using a
  cryptographically authenticated credential, not its IP address or name.
- [x] List and revoke remembered browsers, and handle cleared browser storage
  and lost or compromised credentials.
- [x] Keep first-time approval and certificate trust separate from remembered
  device authorization.

## Automatic reconnection

- [ ] Recover a trusted viewer's signaling and WebRTC connection after a
  temporary interruption while sharing remains active.
- [ ] Stop retries after explicit disconnection, revocation or sharing stop;
  use bounded retry backoff.
- [x] Require source selection and confirmation again after an application
  restart. Respect Ubuntu Wayland portal permissions.
- [ ] Investigate the PipeWire thread-loop assertion printed during Wayland
  source selection and shutdown. The live test resumed video but remains failing
  while this diagnostic occurs. The isolated X11 live test also reports a pixel
  buffer initialization error.

## Verification and certificate lifecycle

- [ ] Test `.local` resolution, CA installation and HTTPS in Firefox and Chrome
  on Android, including actual screen capture and video playback.
- [ ] Test the certificate setup QR, download, fingerprint verification and
  CA installation on Android.
- [ ] Verify browser pairing and active-stream revocation on Android.
- [ ] Test recovery from network loss, device sleep and browser reload with
  real devices and a live stream.
- [ ] Provide an explicit CA recovery and rotation workflow before the local CA
  expires or if its key is compromised. Never silently replace a trusted CA.
