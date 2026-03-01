# CLT Startup Index — Enhancements

## ENH-002: More intelligent search for ambiguous company names

Some company names are common words that produce noisy results even with word-boundary matching (e.g. "Polymer" returns articles about the material, "Path" returns unrelated path/trail articles). Possible approaches:
- Allow per-company search query overrides in the sheet (e.g. a "pulse_query" column)
- Combine company name with a known keyword alias (e.g. `"Polymer" "Charlotte" software`)
- Detect low-signal companies and flag them for manual query tuning

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
