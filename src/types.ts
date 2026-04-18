// This file defines the small set of SDK, hook, and room types the plugin uses.

export interface ModelRef {
  providerID?: string;
  modelID?: string;
  variant?: unknown;
}

export interface SessionMessage {
  info: {
    id: string;
    role: string;
    sessionID: string;
    agent?: string;
    model?: ModelRef;
    variant?: unknown;
  };
  parts?: unknown[];
}

export interface PromptBody {
  noReply?: boolean;
  parts: Array<{ type: string; text?: string; ignored?: boolean }>;
  agent?: string;
  model?: { providerID?: string; modelID?: string };
}

export interface OpenCodeSessionClient {
  session: {
    prompt: (params: { path: { id: string }; body: PromptBody }) => Promise<{ data?: unknown }>;
    promptAsync?: (params: { path: { id: string }; body: PromptBody }) => Promise<{ data?: unknown }>;
    messages: (params: { path: { id: string } }) => Promise<{ data?: SessionMessage[] }>;
  };
}

export interface ToolContext {
  sessionID: string;
}

export interface Part {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface CommandInput {
  command: string;
  sessionID: string;
  arguments: string;
}

export interface CommandOutput {
  parts: Part[];
}

export interface ConfigTransformOutput {
  command?: Record<
    string,
    {
      description?: string;
      template: string;
      agent?: string;
      model?: string;
      subtask?: boolean;
    }
  >;
  experimental?: {
    subagent_tools?: string[];
    [key: string]: unknown;
  };
}

export interface UserMessage {
  info: {
    id: string;
    sessionID: string;
    role: string;
    agent?: string;
    model?: ModelRef;
    variant?: unknown;
  };
  parts: unknown[];
}

export interface MessagesTransformOutput {
  messages: UserMessage[];
}

export interface SystemTransformInput {
  sessionID?: string;
}

export interface SystemTransformOutput {
  system: string[];
}

export interface SessionStatusInput {
  sessionID: string;
  status: {
    type: 'idle' | 'busy' | 'retry';
  };
}

export interface SessionIdleInput {
  sessionID: string;
}

export interface SessionDeletedInput {
  sessionID: string;
}

export interface PluginEvent {
  type: string;
  properties: unknown;
}

export interface SharedSession {
  sessionId: string;
  alias: string;
  room: string;
  ownerPid?: number;
  joinedAt: number;
  updatedAt: number;
  heartbeatAt: number;
  status: 'idle' | 'busy';
  history: string[];
  nextMessage: number;
}

export interface SharedMessage {
  id: string;
  msgIndex: number;
  fromSessionId: string;
  from: string;
  toSessionId: string;
  body: string;
  createdAt: number;
  wakeAt?: number;
  handledAt?: number;
  presentedAt?: number;
}

export interface SharedRoom {
  version: 1;
  sessions: Record<string, SharedSession>;
  messages: SharedMessage[];
}

export interface RoomView {
  self?: SharedSession;
  room?: string;
  peers: SharedSession[];
  messages: SharedMessage[];
}

export interface HandledMessage {
  id: number;
  from: string;
  body: string;
}

export interface LocalSession {
  alias: string;
  status: 'idle' | 'busy';
}

export interface WakeCandidate {
  sessionId: string;
  from: string;
  msgIndices: number[];
}
