# Common Crawl index answers for offline tests

These files use the exact format of the Common Crawl CDX API (`output=json`, one JSON object per line, and the
`showNumPages=true` answer). They are hand-written, not recorded: on 2026-09-25 the robots.txt of
index.commoncrawl.org and data.commoncrawl.org says `User-agent: * / Disallow: /`, so jobleft sent no index
request. The board tokens are made up (acme-robotics, betacorp, ...). Replay them with:

    node packages/boards/scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --host job-boards.greenhouse.io \
      --host jobs.ashbyhq.com --pages 0-1 --replay packages/boards/test/fixtures/cc
