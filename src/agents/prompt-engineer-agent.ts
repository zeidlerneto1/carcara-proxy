import { AgentTask } from '../types.js';
import { CarcaraClient } from '../carcara-client.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface PromptVariant {
  prompt: string;
  score: number;
  scores: Record<string, number>;
  generation: number;
}

export class PromptEngineerAgent {
  private client: CarcaraClient;

  constructor(client: CarcaraClient) { this.client = client; }

  async execute(task: AgentTask): Promise<PromptVariant[]> {
    const input = task.input as any;
    const populationSize = input.populationSize || 4;
    const maxGenerations = task.config?.maxGenerations || 3;
    const model = input.model || this.client.getDefaultModel();

    let population = await this.generateInitialPopulation(input, populationSize, model);
    let generation = 0;

    while (generation < maxGenerations) {
      generation++;
      logger.info({ generation, populationSize }, 'PromptEngineerAgent evoluindo');

      for (const variant of population) {
        if (variant.score === 0) variant.score = await this.evaluateVariant(variant, input, model);
      }
      population.sort((a, b) => b.score - a.score);
      if (population[0].score >= 0.9) break;

      const elite = population.slice(0, Math.ceil(populationSize / 2));
      const mutants = await this.mutate(elite, input, model, populationSize - elite.length);
      population = [...elite, ...mutants];
    }

    return population.sort((a, b) => b.score - a.score);
  }

  private async generateInitialPopulation(input: any, size: number, model: string): Promise<PromptVariant[]> {
    const prompt = `Gere ${size} variacoes do seguinte prompt, cada uma otimizada para: ${input.objective}
\nPROMPT ORIGINAL:\n${input.originalPrompt}
\nCriterios: ${input.evaluationCriteria.join(', ')}
\nForneca cada variacao numerada (1., 2., etc.) sem explicacoes adicionais.`;

    const response = await this.client.chatCompletion(prompt, model);
    const text = response.choices[0].message.content;
    const variants: PromptVariant[] = [];
    const matches = text.match(/\d+\.\s*([^\n]+(?:\n(?!\d+\.)[^\n]*)*)/g) || [];

    for (const match of matches.slice(0, size)) {
      variants.push({ prompt: match.replace(/^\d+\.\s*/, '').trim(), score: 0, scores: {}, generation: 0 });
    }
    while (variants.length < size) {
      variants.push({ prompt: input.originalPrompt, score: 0, scores: {}, generation: 0 });
    }
    return variants;
  }

  private async evaluateVariant(variant: PromptVariant, input: any, model: string): Promise<number> {
    const testInputs = input.testInputs || [input.objective];
    let totalScore = 0;
    const scores: Record<string, number> = {};

    for (const testInput of testInputs) {
      const response = await this.client.chatCompletion(`${variant.prompt}\n\nInput de teste: ${testInput}`, model);
      const output = response.choices[0].message.content;
      for (const criterion of input.evaluationCriteria) {
        const sc = this.scoreCriterion(output, criterion);
        scores[criterion] = (scores[criterion] || 0) + sc;
        totalScore += sc;
      }
    }

    const maxPossible = testInputs.length * input.evaluationCriteria.length;
    variant.scores = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v / testInputs.length]));
    return totalScore / maxPossible;
  }

  private scoreCriterion(output: string, criterion: string): number {
    const lower = output.toLowerCase();
    const len = output.length;
    switch (criterion.toLowerCase()) {
      case 'brevidade': return Math.max(0, 1 - len / 2000);
      case 'clareza': return lower.includes('passo') || lower.includes('primeiro') ? 0.8 : 0.5;
      case 'precisao tecnica': return /[{}=;]/.test(output) || lower.includes('exemplo') ? 0.9 : 0.5;
      case 'completude': return len > 100 ? 0.8 : 0.3;
      default: return 0.5;
    }
  }

  private async mutate(elite: PromptVariant[], input: any, model: string, count: number): Promise<PromptVariant[]> {
    const mutants: PromptVariant[] = [];
    const prompt = `A partir destes prompts bem avaliados, gere ${count} novas variacoes mutadas:
${elite.map((e, i) => `${i + 1}. ${e.prompt}`).join('\n')}
\nCriterios: ${input.evaluationCriteria.join(', ')}
\nForneca cada mutacao numerada.`;

    const response = await this.client.chatCompletion(prompt, model);
    const text = response.choices[0].message.content;
    const matches = text.match(/\d+\.\s*([^\n]+(?:\n(?!\d+\.)[^\n]*)*)/g) || [];

    for (const match of matches.slice(0, count)) {
      mutants.push({ prompt: match.replace(/^\d+\.\s*/, '').trim(), score: 0, scores: {}, generation: (elite[0]?.generation || 0) + 1 });
    }
    while (mutants.length < count) {
      mutants.push({ prompt: elite[Math.floor(Math.random() * elite.length)].prompt, score: 0, scores: {}, generation: (elite[0]?.generation || 0) + 1 });
    }
    return mutants;
  }
}
