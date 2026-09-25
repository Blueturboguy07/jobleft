# JazzHR

Decision: **not crawled**. Reason: no documented public feed. Status: skipped (no adapter was built).

## Checked on

2026-09-25, sources-ats lane. Documentation pages only; no request was sent to any applytojob.com page.

## Evidence

| Source | What it says |
|---|---|
| JazzHR API & Platform Documentation: https://apidoc.jazzhrapis.com/ | Lists Candidate Export Webhooks, Assessment API, Screening API, SSO with OpenID Connect and "Apply API: Allows partners to send applications to JazzHR through a RESTful interface." No keyless job feed. |
| JazzHR help centre (help.jazzhr.com, "Integrate JazzHR with your Career Page/Website") | The page loads only in a browser app, and a plain fetch failed with a certificate error on 2026-09-25, so it could not be read. Search summaries describe the customer API and an XML feed that use the employer's own API key. |
| Audit 05 section 1.2 (2026-09-24) | `https://{slug}.applytojob.com/apply` is HTML only; "No JSON feed confirmed". |

The customer API (`api.resumatorapi.com`) needs the employer's API key, which jobleft does not have and must not ask for. Skipped under the lane rule.

## What would change the decision

A JazzHR page that documents a public, keyless job feed, or the owner's approval.

## Recognition

Links on `*.applytojob.com` are recognised (`jazzhr`, `crawlable: false`); nothing is sent.
