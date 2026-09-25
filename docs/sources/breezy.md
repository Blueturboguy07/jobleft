# Breezy HR

Decision: **not crawled**. Reason: no documented public feed. Status: skipped (no adapter was built).

## Checked on

2026-09-25, sources-ats lane. Documentation and help-centre pages only; no request was sent to any Breezy careers portal.

## Evidence

| Source | What it says |
|---|---|
| Breezy API documentation index: https://developer.breezy.hr/llms.txt | The API covers companies, positions, candidates and webhooks behind sign-in (for example "/company/{id}: ... Access requires the ..."). No public job feed is listed. |
| Breezy help centre search for "json": https://help.breezy.hr/en/?q=json | "We couldn't find any articles for: json" |
| Breezy help centre search for "feed": https://help.breezy.hr/en/?q=feed | Only "Publishing Positions on Indeed" (an XML feed that Breezy sends to Indeed), not a public feed for others. |
| Audit 05 section 1.2 (2026-09-24) | `GET https://{slug}.breezy.hr/json` answered without a key in a test, with a `salary` field. It is not documented by Breezy. |

The `/json` path of the hosted careers portal is undocumented. Breezy has not said programs may read it. Skipped under the lane rule.

## What would change the decision

A Breezy page that documents a public job feed, or the owner's approval.

## Recognition

Links on `*.breezy.hr` are recognised (`breezy`, `crawlable: false`); nothing is sent.
