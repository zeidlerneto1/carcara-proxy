export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (params: any) => Promise<any>;
}

export const customMCPTools: MCPToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web for information',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const { query } = params;
      try {
        const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
        const data = await response.json();
        return {
          query,
          results: [
            {
              title: data.Heading || 'Search Result',
              snippet: data.Abstract || 'No description available',
              url: data.AbstractURL || '',
            },
            ...(data.RelatedTopics || []).slice(0, 3).map((t: any) => ({
              title: t.Text?.split(' - ')[0] || 'Related',
              snippet: t.Text || '',
              url: t.FirstURL || '',
            })),
          ],
        };
      } catch (error) {
        return { query, results: [], error: 'Search failed' };
      }
    },
  },
  {
    name: 'get_weather',
    description: 'Get current weather for a location',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name or coordinates' },
      },
      required: ['location'],
    },
    handler: async (params) => {
      const { location } = params;
      try {
        const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
        const data = await response.json();
        const current = data.current_condition[0];
        return {
          location,
          temperature: `${current.temp_C}°C`,
          condition: current.weatherDesc[0].value,
          humidity: `${current.humidity}%`,
          wind: `${current.winddir16Point} ${current.windspeedKmph} km/h`,
        };
      } catch (error) {
        return { location, error: 'Weather fetch failed' };
      }
    },
  },
  {
    name: 'calculate',
    description: 'Perform mathematical calculations',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Mathematical expression to evaluate' },
      },
      required: ['expression'],
    },
    handler: async (params) => {
      const { expression } = params;
      try {
        const result = Function(`'use strict'; return (${expression})`)();
        return { expression, result };
      } catch (error: any) {
        return { expression, error: error.message };
      }
    },
  },
  {
    name: 'get_time',
    description: 'Get current time for a timezone',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'Timezone (e.g., America/Sao_Paulo, UTC)' },
      },
      required: ['timezone'],
    },
    handler: async (params) => {
      const { timezone = 'UTC' } = params;
      try {
        const now = new Date();
        const timeString = now.toLocaleString('pt-BR', { timeZone: timezone });
        return { timezone, datetime: timeString, timestamp: now.toISOString() };
      } catch (error) {
        return { timezone, datetime: new Date().toISOString() };
      }
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command (use with caution)',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
    handler: async (params) => {
      const { command } = params;
      const { execSync } = await import('child_process');
      try {
        const output = execSync(command, { encoding: 'utf-8', timeout: 10000 });
        return { command, output: output.trim() };
      } catch (error: any) {
        return { command, error: error.message, stderr: error.stderr };
      }
    },
  },
];
