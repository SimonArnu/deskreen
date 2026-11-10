# Remaining work

## Trusted viewing devices

- [ ] Allow an explicitly approved browser to be remembered using a
  cryptographically authenticated credential, not its IP address or name.
- [ ] List and revoke remembered browsers, and handle cleared browser storage
  and lost or compromised credentials.
- [ ] Keep first-time approval and certificate trust separate from remembered
  device authorization.

## Automatic reconnection

- [ ] Recover a trusted viewer's signaling and WebRTC connection after a
  temporary interruption while sharing remains active.
- [ ] Stop retries after explicit disconnection, revocation or sharing stop;
  use bounded retry backoff.
- [ ] Decide whether reconnecting after an application restart should require
  selecting the screen again. Respect Ubuntu Wayland portal permissions.

## Verification and certificate lifecycle

- [ ] Test `.local` resolution, CA installation and HTTPS in Firefox and Chrome
  on Android, including actual screen capture and video playback.
- [ ] Test recovery from network loss, device sleep and browser reload with
  real devices and a live stream.
- [ ] Provide an explicit CA recovery and rotation workflow before the local CA
  expires or if its key is compromised. Never silently replace a trusted CA.
