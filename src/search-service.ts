import axios from 'axios';

export class SearchService {
  async duckDuckGo(query: string): Promise<any> {
    try {
      const response = await axios.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
        timeout: 10000,
      });

      const data = response.data;
      const results: any[] = [];

      if (data.Abstract) {
        results.push({
          title: data.Heading || 'Result',
          snippet: data.Abstract,
          url: data.AbstractURL,
          source: data.AbstractSource,
        });
      }

      if (data.RelatedTopics) {
        data.RelatedTopics.slice(0, 5).forEach((topic: any) => {
          if (topic.Text) {
            results.push({
              title: topic.Text.split(' - ')[0],
              snippet: topic.Text,
              url: topic.FirstURL,
            });
          }
        });
      }

      return { query, results };
    } catch (error) {
      return { query, results: [], error: 'Search failed' };
    }
  }

  async wikipedia(query: string): Promise<any> {
    try {
      const response = await axios.get('https://en.wikipedia.org/w/api.php', {
        params: {
          action: 'query',
          list: 'search',
          srsearch: query,
          format: 'json',
          origin: '*',
        },
        timeout: 10000,
      });

      const results = response.data.query.search.slice(0, 5).map((item: any) => ({
        title: item.title,
        snippet: item.snippet?.replace(/<[^>]*>/g, ''),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`,
        wordCount: item.wordcount,
      }));

      return { query, results };
    } catch (error) {
      return { query, results: [], error: 'Wikipedia search failed' };
    }
  }

  async serpAPI(query: string, apiKey?: string): Promise<any> {
    const key = apiKey || process.env.SERPAPI_KEY;
    if (!key) {
      return { query, results: [], error: 'SERPAPI_KEY not configured' };
    }

    try {
      const response = await axios.get('https://serpapi.com/search', {
        params: { q: query, api_key: key, engine: 'google' },
        timeout: 10000,
      });

      const results = (response.data.organic_results || []).slice(0, 5).map((item: any) => ({
        title: item.title,
        snippet: item.snippet,
        url: item.link,
      }));

      return { query, results };
    } catch (error) {
      return { query, results: [], error: 'SerpAPI search failed' };
    }
  }

  async braveSearch(query: string, apiKey?: string): Promise<any> {
    const key = apiKey || process.env.BRAVE_API_KEY;
    if (!key) {
      return { query, results: [], error: 'BRAVE_API_KEY not configured' };
    }

    try {
      const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q: query, count: 5 },
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': key,
        },
        timeout: 10000,
      });

      const results = (response.data.web?.results || []).map((item: any) => ({
        title: item.title,
        snippet: item.description,
        url: item.url,
      }));

      return { query, results };
    } catch (error) {
      return { query, results: [], error: 'Brave search failed' };
    }
  }

  async search(query: string, providers: string[] = ['duckduckgo', 'wikipedia']): Promise<any> {
    const allResults: any[] = [];

    for (const provider of providers) {
      try {
        let result;
        switch (provider) {
          case 'duckduckgo': result = await this.duckDuckGo(query); break;
          case 'wikipedia': result = await this.wikipedia(query); break;
          case 'serpapi': result = await this.serpAPI(query); break;
          case 'brave': result = await this.braveSearch(query); break;
        }
        if (result?.results) {
          allResults.push(...result.results.map((r: any) => ({ ...r, provider })));
        }
      } catch (error) {
        console.error(`Search provider ${provider} failed:`, error);
      }
    }

    return { query, results: allResults };
  }
}
