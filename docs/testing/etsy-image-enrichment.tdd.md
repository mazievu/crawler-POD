# Etsy image enrichment — TDD evidence

## Red

`node --test test/etsy-image-enrichment.test.js` initially failed because the
image-enrichment module did not exist.

## Green

`node --test test/etsy-image-enrichment.test.js test/etsy-analytics-import.test.js`
passes. The tests cover successful persistence, empty image responses, and a
failed capture followed by a later successful capture.

## Safety

The enrichment command selects only Etsy listing snapshots whose `image` field
is blank. It processes a bounded batch sequentially with a delay, so it can be
rerun safely without replacing existing images.
