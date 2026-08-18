import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";

/** Config fields consumed by the LLM factory. */
export interface LLMConfig {
  llmProvider: string;
  llmModel: string;
  llmTemperature: number;
  baseUrl?: string;
}

/**
 * Factory that instantiates the configured LangChain chat model.
 * All models are accessed via the local Carcara Proxy API (default: localhost:3030).
 * The proxy handles routing to Qwen, DeepSeek, and other models.
 *
 * @throws {Error} if the model does not support tool binding.
 */
export function createLLM(config: LLMConfig): BaseChatModel {
  const provider = config.llmProvider.toLowerCase();
  
  // Use Carcara Proxy API for all models (Qwen, DeepSeek, etc.)
  // Default to localhost:3030 if no baseUrl provided
  const baseURL = config.baseUrl || process.env.CARCARA_PROXY_URL || "http://localhost:3030/v1";
  
  // No API key needed - using local proxy
  const apiKey = "not-needed"; // Placeholder, not used
  
  const model = new ChatOpenAI({
    apiKey: apiKey,
    model: config.llmModel || "qwen-max",
    temperature: config.llmTemperature,
    configuration: {
      baseURL: baseURL,
    },
  });

  // Validate tool-binding support early, before the model reaches the agent loop
  if (!model.bindTools) {
    throw new Error(
      `LLM provider "${provider}" via Carcara Proxy does not support tool binding`
    );
  }

  return model;
}
