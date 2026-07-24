export interface AgentImageAttachment {
  id: string;
  name: string;
  mediaType: string;
  data: string;
}

export interface AgentTextContentBlock {
  type: 'text';
  text: string;
}

export interface AgentImageContentBlock {
  type: 'image';
  image: AgentImageAttachment;
}

export type AgentContentBlock = AgentTextContentBlock | AgentImageContentBlock;

export function normalizeAgentImageAttachments(value: unknown): AgentImageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AgentImageAttachment | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const mediaType = String(raw.mediaType || '').trim();
      const data = String(raw.data || '').trim();
      if (!mediaType.startsWith('image/') || !data) return null;
      return {
        id: String(raw.id || ''),
        name: String(raw.name || ''),
        mediaType,
        data
      };
    })
    .filter((item): item is AgentImageAttachment => Boolean(item));
}

export function agentUserMessageContent(
  prompt: unknown,
  attachments: AgentImageAttachment[] = []
): string | AgentContentBlock[] {
  const text = String(prompt || '').trim();
  if (attachments.length === 0) return text;
  return [
    ...attachments.map((image): AgentImageContentBlock => ({ type: 'image', image })),
    ...(text ? [{ type: 'text' as const, text }] : [])
  ];
}

export function agentContentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content || '');
  return content
    .filter((block): block is AgentTextContentBlock => (
      Boolean(block)
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
    ))
    .map((block) => String(block.text || ''))
    .join('\n');
}

export function agentContentHasImages(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => (
    Boolean(block)
    && typeof block === 'object'
    && (block as { type?: unknown }).type === 'image'
  ));
}

export function agentContentPreview(content: unknown): string {
  if (!Array.isArray(content)) return String(content || '');
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const typed = block as AgentContentBlock;
      if (typed.type === 'text') return String(typed.text || '');
      if (typed.type === 'image') return `[image: ${typed.image?.name || typed.image?.mediaType || 'unknown'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
