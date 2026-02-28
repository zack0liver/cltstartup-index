# CLT Startup Index — Enhancements

## ENH-001: Reddit layer for Pulse feed

Add Reddit as a social signal source alongside Google News in the Pulse feed.

**Approach:**
- No API key required for basic Reddit search
- Query: `https://www.reddit.com/search.json?q="{CompanyName}"+Charlotte`
- Filter to relevant subreddits: r/Charlotte, r/startups, r/entrepreneur, r/smallbusiness
- Apply same relevance scoring as news articles
- Tag in the feed UI differently from news articles (Reddit icon/pill vs. source logo)

**Notes:**
- Reddit posts tend to be more conversational and community-driven vs. formal news
- Signal-to-noise may be low for smaller/newer companies
- Deferred until core news feed is stable
