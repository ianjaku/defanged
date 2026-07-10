/**
 * Python Interpreter - Main Entry Point
 * 
 * A sandboxed Python interpreter for executing AI-generated scripts.
 * Supports tool injection for data fetching functions.
 */

export { tokenize, Lexer } from './lexer';
export { parse, Parser } from './parser';
export { createInterpreter, Interpreter } from './interpreter';
export type { ToolDefinition, ToolParameter, InterpreterOptions, ResourceLimits } from './interpreter';

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

export interface ToolsPromptOptions {
  /** Append a short description of the supported Python subset (whitelisted
   *  imports, no with/class/async, ...) so hosts don't hand-write it. */
  includeLanguageNotes?: boolean;
}

function renderTool(tool: ToolDefinition): string {
  const params = (tool.parameters ?? []).map(p => {
    let sig = p.name;
    if (p.type) sig += `: ${p.type}`;
    if (p.default !== undefined) sig += ` = ${p.default}`;
    return sig;
  }).join(', ');
  const lines = [`- ${tool.name}(${params}) - ${tool.description || 'No description'}`];
  for (const p of tool.parameters ?? []) {
    if (p.description) lines.push(`    ${p.name}: ${p.description}`);
  }
  return lines.join('\n');
}

const LANGUAGE_NOTES = `Language notes:
- The interpreter runs a Python subset with no file, network, or process access.
- Only these modules can be imported: datetime, math, statistics, re.
- class definitions, with-statements, and async/await are not supported — use plain functions and dicts.
- Tool calls look synchronous: call them like normal functions (no await). Keyword arguments are supported.`;

/**
 * Generate a system prompt based on available tools. Tools that share a
 * `group` are rendered under a section heading, in first-seen order.
 */
export function generateToolsPrompt(tools: ToolDefinition[], options: ToolsPromptOptions = {}): string {
  const groups = new Map<string, ToolDefinition[]>();
  for (const tool of tools) {
    const key = tool.group ?? '';
    const list = groups.get(key);
    if (list) list.push(tool);
    else groups.set(key, [tool]);
  }

  const sections: string[] = [];
  for (const [group, groupTools] of groups) {
    const body = groupTools.map(renderTool).join('\n');
    sections.push(group ? `## ${group}\n${body}` : body);
  }

  const parts = [
    `You have access to the following tools through Python code:

${sections.join('\n\n')}

To use these tools, write Python code that calls them as functions. Example:
\`\`\`python
data = tool_name()
result = process(data)
result
\`\`\`

The last expression in your code will be returned as the result.`,
  ];
  if (options.includeLanguageNotes) parts.push(LANGUAGE_NOTES);
  return parts.join('\n\n');
}
