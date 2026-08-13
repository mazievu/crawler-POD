# Backend Coverage Matrix

## Responsibility
This matrix documents the primary and fallback backends for each channel, along with required dependencies and current verification statuses.

## Public API
N/A - This is a documentation module.

| Channel | Primary Backend | Fallback | Dependencies | Verification | Limitation | Next Step |
|---|---|---|---|---|---|---|
| reddit | local-scraper | apify | none / optional apify | local pass | limited selectors | add SearXNG discovery |
| toidispy | cdp | legacy route | Chrome CDP + login | login required | manual login | refine check-login endpoint |
| facebook_posts | apify | none | APIFY_TOKEN + actor entitlement | unverified | paid actor | add SearXNG fallback |
| etsy | apify | local-scraper | APIFY_TOKEN / SearXNG | unverified | paid actor | enhance local SearXNG backend |
| ebay | local-scraper | apify | none / optional apify | local pass | limited regions | add more region support |
| pinterest | local-scraper | apify | none | local pass | image parsing limits | improve image scraping |
| shopify | local-scraper | apify | none | local pass | requires valid shopify URL | add catalog discovery |
