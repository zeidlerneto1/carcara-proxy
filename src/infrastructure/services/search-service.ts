import axios from 'axios';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface SearchResult {
  provider: string;
  query: string;
  results: any[];
  totalResults: number;
  durationMs: number;
}

export class SearchService {
  async search(query: string, providers?: string[]): Promise<SearchResult[]> {
    const start = Date.now();
    const proms: Promise<SearchResult>[] = [];
    const useProviders = providers || ['duckduckgo', 'wikipedia'];
    if (useProviders.includes('duckduckgo')) proms.push(this.duckDuckGo(query));
    if (useProviders.includes('wikipedia')) proms.push(this.wikipedia(query));
    const results = await Promise.all(proms);
    logger.info({ query, providers: useProviders, durationMs: Date.now() - start }, 'Busca completa');
    return results;
  }

  async duckDuckGo(query: string): Promise<SearchResult> {
    const start = Date.now();
    try {
      const response = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q: query, kl: 'us-en' },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const html = response.data;
      const results: any[] = [];
      // Primary regex for current DuckDuckGo HTML layout
      const regex = /<a[^>]*class=["']result__a["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = regex.exec(html)) !== null && results.length < 5) {
        const title = match[2]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .trim();
        const url = match[1].replace(/^\/\//, 'https://').trim();
        if (title && url && !url.includes('duckduckgo.com') && !results.find(r => r.url === url)) {
          results.push({ title, url });
        }
      }
      // Fallback: extract any external links with titles
      if (results.length === 0) {
        const fallbackRegex = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{10,300}?)<\/a>/gi;
        while ((match = fallbackRegex.exec(html)) !== null && results.length < 5) {
          const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          const url = match[1].trim();
          if (title && url && !url.includes('duckduckgo.com') && !results.find(r => r.url === url)) {
            results.push({ title, url });
          }
        }
      }
      return { provider: 'duckduckgo', query, results, totalResults: results.length, durationMs: Date.now() - start };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Erro DuckDuckGo');
      return { provider: 'duckduckgo', query, results: [], totalResults: 0, durationMs: Date.now() - start };
    }
  }

  async wikipedia(query: string): Promise<SearchResult> {
    const start = Date.now();
    try {
      const response = await axios.get('https://pt.wikipedia.org/w/api.php', {
        params: { action: 'query', list: 'search', srsearch: query, format: 'json', origin: '*' },
        timeout: 10000,
      });
      const searchResults = response.data?.query?.search || [];
      const results = searchResults.slice(0, 5).map((r: any) => ({
        title: r.title,
        snippet: r.snippet.replace(/<span class="searchmatch">/g, '').replace(/<\/span>/g, ''),
        pageId: r.pageid,
      }));
      return { provider: 'wikipedia', query, results, totalResults: searchResults.length, durationMs: Date.now() - start };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Erro Wikipedia');
      return { provider: 'wikipedia', query, results: [], totalResults: 0, durationMs: Date.now() - start };
    }
  }
}
