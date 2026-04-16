/**
 * Python Interpreter - Main Entry Point
 * 
 * A sandboxed Python interpreter for executing AI-generated scripts.
 * Supports tool injection for data fetching functions.
 */

export { tokenize, Lexer } from './lexer';
export { parse, Parser } from './parser';
export { createInterpreter, Interpreter } from './interpreter';
export type { ToolDefinition, InterpreterOptions } from './interpreter';

// Re-export types
export * from './tokens';
export * from './ast';
export * from './values';
export * from './errors';

// Convenience function for quick execution
import { createInterpreter, type ToolDefinition } from './interpreter';

export async function runPython(
  code: string,
  tools?: ToolDefinition[],
  onPrint?: (output: string) => void
): Promise<any> {
  const interpreter = createInterpreter({ tools, onPrint });
  return await interpreter.run(code);
}

/**
 * Generate a system prompt for Claude based on available tools
 */
export function generateToolsPrompt(tools: ToolDefinition[]): string {
  const toolDescriptions = tools.map(tool => {
    return `- ${tool.name}() - ${tool.description || 'No description'}`;
  }).join('\n');

  return `You have access to the following tools through Python code:

${toolDescriptions}

To use these tools, write Python code that calls them as functions. Example:
\`\`\`python
data = tool_name()
result = process(data)
result
\`\`\`

The last expression in your code will be returned as the result.`;
}

