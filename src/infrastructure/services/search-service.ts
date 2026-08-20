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
        params: { q: query }, timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarcaraBot/1.0)' },
      });
      const html = response.data;
      const results: any[] = [];
      const regex = /<a rel="nofollow" class="result__a" href="([^"]+)">([^<]+)<\/a>/g;
      let match;
      while ((match = regex.exec(html)) !== null && results.length < 5) {
        results.push({ title: match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), url: match[1] });
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
