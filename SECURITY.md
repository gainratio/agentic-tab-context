# Security policy

Agentic Tab Context lets a local coding assistant read and operate a browser tab you
choose. That is powerful by design, so the security model is documented here as plainly
as the feature.

## Reporting a vulnerability

Please **do not** open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository (Security → Report a vulnerability), or email
**harish.seshadri@gmail.com** if that is unavailable.

Include the version, the browser and assistant you used, and the smallest reproduction
you can. You can expect an acknowledgement within a few days.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x | :white_check_mark: |
| < 0.3 | :x: |

## Security model

- **Local only.** The extension talks to the `atc` daemon over Chrome/Firefox native
  messaging. It opens no network connections, and the daemon listens on a Unix socket
  under `ATC_HOME` with owner-only permissions. Nothing is sent to GainRatio.
- **The user chooses the tab.** The extension can see tab titles and addresses, and can
  read or act in a tab only while that tab is bound. The popup and the assistant both go
  through `atc bind`.
- **The page is untrusted.** A bound page can contain prompt-injection text. The bundled
  skill tells the assistant to treat page content as data, never as instructions, and
  never to type passwords or secrets unless the user explicitly asks.
- **Password fields are redacted.** Inspection omits password control values. Other page
  content, console output and network metadata can still be sensitive; the privacy
  policy describes what is retained locally.
- **The assistant is trusted software.** The extension does not sandbox your coding
  assistant. If the assistant is compromised, or you point it at a hostile page and
  follow its instructions, it can act in the tab you bound.

## In scope

- Escaping the bound-tab boundary: reading or acting in a tab that was never bound, or
  reaching a tab after `atc unwatch`/`atc shutdown`.
- Reaching the daemon from another user, or from a web page, without the extension.
- Reading password-field values through the inspection API.
- A native-host manifest or install path that lets a different extension id connect.
- Supply-chain or release-integrity issues in the installer, build, or published assets.

## Out of scope

- What your assistant vendor does with the information you let it read.
- Browser zero-days, or a compromised local account that can already read your files.
- The assistant following instructions embedded in a page after the user approved that
  page; see the prompt-injection note above.
