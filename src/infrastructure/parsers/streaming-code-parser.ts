export interface ExtractedStream {
  language: string;
  code: string;
  isComplete: boolean;
}

export class StreamingCodeParser {
  private buffer: string = "";
  private currentLanguage: string = "";
  private currentCode: string = "";
  private inCodeBlock: boolean = false;

  public feed(token: string): ExtractedStream {
    this.buffer += token;
    this.processBuffer();
    return {
      language: this.currentLanguage || "text",
      code: this.currentCode,
      isComplete: this.checkCompletion()
    };
  }

  private processBuffer() {
    const lines = this.buffer.split("\n");
    let codeAccumulator: string[] = [];
    let inside = false;
    let lang = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("```")) {
        if (!inside) {
          inside = true;
          lang = line.replace("```", "").trim();
        } else {
          inside = false;
        }
      } else if (inside) {
        codeAccumulator.push(line);
      }
    }
    this.inCodeBlock = inside;
    this.currentLanguage = lang;
    this.currentCode = codeAccumulator.join("\n");
  }

  private checkCompletion(): boolean {
    const matches = this.buffer.match(/```/g);
    return matches ? matches.length >= 2 : false;
  }

  public reset() {
    this.buffer = "";
    this.currentLanguage = "";
    this.currentCode = "";
    this.inCodeBlock = false;
  }

  public getBuffer(): string {
    return this.buffer;
  }
}
