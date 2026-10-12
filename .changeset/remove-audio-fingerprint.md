---
'scan-chart': patch
---

Remove the unused audio fingerprint code and its dependencies (`stream-audio-fingerprint`, `fluent-ffmpeg`, `workerpool`). Nothing called this code, so scan results do not change. Installs no longer fetch a dependency from GitHub.
