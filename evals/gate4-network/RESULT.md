# Gate 4 (i-network) result, 2026-09-25T15:00:26.140Z

Fixture A: 50 made-up people with LinkedIn note lines, a BOM, one malformed and one blank row, near-name and messy-field traps. Fixture B: 45 of A (2 moved), 10 new, 5 left out. A loopback mock model keeps every request body.

| Check | Result | Evidence |
|---|---|---|
| O3.empty-before-import | PASS | before any import: 0 contacts, job network count null |
| O1.import-report | PASS | import -> 200: imported 50, skipped [{"line":56,"reason":"Broken row: it has 1 fields, but the header has 7."}], warnings ["47 of 50 people have no email address in the file (normal for this export). No email is guessed."], inFile 50 |
| O13.messy-file | PASS | BOM, Japanese and Hebrew names kept as written: true true; blank company -> null: true; blank position -> null: true |
| O2.count-and-names | PASS | job at Stripe: count 3; names Striper, Stripes, Stripey; "Stripe Tax Advisors LLP" counted: false; explanation: {"companyKey":"stripe","companyName":"Stripe","count":3,"matched":[{"name":"Stripe, Inc.","count":3,"how":"Same company name once the legal suffix \"inc\" is ignored."}],"notCounted":[{"name":"Stripe  |
| O3.only-the-file | PASS | 9 people shown across 4 target jobs; not in the file: 0 |
| O4.rank | PASS | order at Woodgrove: Enginerd > Managerly > Recruiterson > Internly > Longago > Blankpos; every entry has plain-word reasons: true; first reasons: Company in your file: "Woodgrove Cloud". / Does the same kind of work as the job: the title is "Platform Engineer", the job is "Platform Engineer". / Same field as the job (engineering): the title is  |
| O4.stable-after-restart | PASS | ranking identical after a restart |
| O5.plan | PASS | plan after restart: Woodgrove Cloud: Managerly (Draft a short note, then send it yourself.), Enginerd (Draft a short note, then send it yourself.) |
| O5.remove-from-plan | PASS | removed one: plan has 1 at Woodgrove; the person is still in the network: true |
| O14.template-draft | PASS | template draft -> 200: "Hi Ana, I'm Jordan Testwell. I'm interested in the Platform Engineer role at Woodgrove Cloud and would value your perspective. Would you be open to a short chat?" |
| O14.no-provider-plain | PASS | AI draft with no provider -> 409: No AI provider is set up. Set one up in Settings > AI (a model on this computer works), or use the plain template. |
| O6.ai-draft | PASS | AI draft -> 200; provider local:mock-model; text: "Hi Ana, I saw the Platform Engineer opening at Woodgrove Cloud and would love 15 minutes to hear how your team works. Jo"; preview said it sends: contact Ana, job Platform Engineer, aboutMe 86 chars |
| O10.only-this-contact-leaves | PASS | 1 model call(s); other people's names in what was sent: 0; the contact's own name present: true |
| O7.stages-survive | PASS | after restart: Stripey=messaged, Stripes=replied, Striper=met; follow-up 2026-09-26 |
| O7.reminder-arrives | PASS | after moving the clock 30 h: 1 notification(s); follow-up notice: {"id":"ntf_78bc3e8dc0cd93ed","kind":"follow_up","title":"jobleft: network follow-up","body":"1 network follow-up is due. Open Network > Due to see who.","target":"/network/followups","createdAt":"2026 |
| O8.reimport | PASS | second import: added 10, updated 2, missing 5; Stripey still messaged with the note: true; the 5 missing people still listed: true |
| O9.map | PASS | coverage: Woodgrove Cloud=5, Stripe=2, Acme Robotics=0, Tailspin Toys=0 |
| O11.no-linkedin | PASS | 0 logged outbound requests, off this computer: 0 () |
| O12.delete-all | PASS | delete -> 200 {"ok":true,"deleted":60,"logCleared":true}; contacts after restart 0; fixture names found in data files: 0; job network count null |

Verdict: PASS