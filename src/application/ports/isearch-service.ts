export interface ISearchService {
  search(query: string, providers?: string[]): Promise<any>;
  duckDuckGo(query: string): Promise<any>;
  wikipedia(query: string): Promise<any>;
}
