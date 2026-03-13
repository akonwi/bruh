# Debug URLs

## List pairing requests
```
https://moltbot-sandbox.akonwi.workers.dev/debug/cli?cmd=bash%20-c%20%22openclaw%20pairing%20list%20--url%20ws%3A%2F%2Flocalhost%3A18789%20--token%20%24%28node%20-e%20%27var%20d%3Drequire%28%22fs%22%29.readFileSync%28%22%2Froot%2F.openclaw%2Fopenclaw.json%22%29%3Bconsole.log%28JSON.parse%28d%29.gateway.auth.token%29%27%29%22
```

## Approve a pairing request (replace CHANNEL and CODE)
```
https://moltbot-sandbox.akonwi.workers.dev/debug/cli?cmd=bash%20-c%20%22openclaw%20pairing%20approve%20CHANNEL%20CODE%20--url%20ws%3A%2F%2Flocalhost%3A18789%20--token%20%24%28node%20-e%20%27var%20d%3Drequire%28%22fs%22%29.readFileSync%28%22%2Froot%2F.openclaw%2Fopenclaw.json%22%29%3Bconsole.log%28JSON.parse%28d%29.gateway.auth.token%29%27%29%22
```
