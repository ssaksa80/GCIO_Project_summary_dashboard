# IIS in front of the dashboard

The Node service listens on `127.0.0.1:8123` and never terminates TLS itself.
IIS holds the corporate certificate and proxies to it. That split is deliberate:
certificate renewal, TLS policy and header hygiene stay in the place Windows
administrators already manage them.

## Prerequisites

- The service installed and answering — see `deploy/install-service.ps1`
- IIS with **URL Rewrite** and **Application Request Routing (ARR)**
- The corporate certificate in the machine store, bound to the site host name
- `NODE_ENV=production` in the environment file, so Node binds loopback only

## 1. Enable the proxy

ARR is off by default and nothing works until it is on.

**IIS Manager → the server node → Application Request Routing Cache → Server
Proxy Settings → tick *Enable proxy* → Apply.**

## 2. Allow the forwarded-protocol variable

**IIS Manager → the site → URL Rewrite → View Server Variables → Add →
`HTTP_X_FORWARDED_PROTO`.**

Without this the rewrite rule below silently fails to set the header, and the
application cannot tell that the original request was HTTPS.

## 3. Create the site

Bind `https://dashboard.<domain>` on port 443 to the certificate. Remove the
port 80 binding, or keep it only to redirect to HTTPS.

## 4. Add `web.config`

Put this in the site root. It proxies everything to the Node process, raises the
upload limit to match the application's own (20 workbooks at 25 MB), and removes
a header that advertises the stack.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Redirect to HTTPS" stopProcessing="true">
          <match url="(.*)" />
          <conditions>
            <add input="{HTTPS}" pattern="off" />
          </conditions>
          <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
        </rule>
        <rule name="Proxy to GCIO" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:8123/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- 20 workbooks at 25 MB each, plus multipart overhead -->
        <requestLimits maxAllowedContentLength="545259520" />
      </requestFiltering>
    </security>
    <httpProtocol>
      <customHeaders>
        <remove name="X-Powered-By" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
```

Note: the application sets its own security headers, including HSTS when
`NODE_ENV=production`. Do not add a second set in IIS — duplicated headers are
how a CSP quietly stops being enforced.

## 5. Server-sent events

The dashboard pushes live ingest updates over SSE on `/api/events`. ARR buffers
responses by default, which holds those events until the buffer fills and makes
the dashboard look frozen. Disable output buffering for the site:

**IIS Manager → the site → Application Request Routing → Proxy → uncheck
*Enable response buffering***, or set it directly:

```powershell
Set-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST/<site name>" `
  -Filter "system.webServer/proxy" -Name "responseBufferLimit" -Value 0
```

The application already sends `X-Accel-Buffering: no`, which some proxies honour,
but ARR does not — so this step is required, not optional.

## 6. If SSO is enabled

Register `https://dashboard.<domain>` as a **redirect URI** on the Entra app
registration (platform: single-page application). The browser sends the ID token
to the dashboard's own origin, so the origin must match exactly, including the
absence of a trailing path.

## Verify

```powershell
# through IIS, over TLS
curl.exe -I https://dashboard.<domain>/healthz          # 200

# the Node process itself, loopback only
curl.exe -I http://127.0.0.1:8123/healthz               # 200

# anonymous access is refused, proving auth survives the proxy
curl.exe -i https://dashboard.<domain>/api/summary      # 401
```

From **another machine**, this must fail to connect:

```powershell
curl.exe -I http://<server>:8123/healthz                # connection refused
```

If it answers, `NODE_ENV` is not `production` and the process is bound to all
interfaces — fix the environment file and restart the service before going
further.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 502.3 from IIS | The Node service is not running, or `PORT` does not match the rewrite target |
| Live updates stop arriving | ARR response buffering is still on — see step 5 |
| Sign-in loops back to the sign-in screen | The session cookie is `Secure`; the site must be HTTPS, and `HTTP_X_FORWARDED_PROTO` must be reaching the app |
| Uploads fail at ~30 MB | `maxAllowedContentLength` was not raised, or the request also passes another proxy with its own limit |
| SSO returns "keys could not be retrieved" | The server cannot reach `login.microsoftonline.com` — check the outbound proxy, then `ENTRA_OFFLINE_JWKS` as a fallback |
