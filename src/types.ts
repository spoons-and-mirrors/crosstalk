// This file defines the small set of SDK, hook, and crosstalk state types the plugin uses.

export interface ModelRef {
  providerID?: string;
  modelID?: string;
  id?: string;
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
    time?: { created?: number; completed?: number };
  };
  parts?: Part[];
}

export interface PromptBody {
  noReply?: boolean;
  parts: Array<{ type: string; text?: string; ignored?: boolean; synthetic?: boolean }>;
  agent?: string;
  model?: { providerID?: string; modelID?: string };
}

export interface CreateSessionBody {
  title?: string;
  agent?: string;
  model?: { providerID?: string; id?: string; variant?: unknown };
}

export interface CreateSessionRequest {
  body: CreateSessionBody;
}

export interface OpenCodeSessionClient {
  session: {
    create?: (input: CreateSessionRequest) => Promise<{ data?: { id?: string; title?: string } }>;
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
  ignored?: boolean;
  synthetic?: boolean;
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
    time?: { created?: number; completed?: number };
    [key: string]: unknown;
  };
  parts: Part[];
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

export type PairSide = 'source' | 'buddy';

export interface PairEndpoint {
  sessionId: string;
  side: PairSide;
  ownerPid?: number;
  status: 'idle' | 'busy';
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  deletedAt?: number;
  agent?: string;
  model?: ModelRef;
}

export interface CrosstalkMessage {
  id: string;
  sequence: number;
  pairId: string;
  label: string;
  fromSide: PairSide;
  toSide: PairSide;
  fromSessionId: string;
  toSessionId: string;
  body: string;
  createdAt: number;
  replyTo?: string;
  wakeAt?: number;
  readAt?: number;
}

export interface CrosstalkPair {
  id: string;
  source: PairEndpoint;
  buddy: PairEndpoint;
  createdAt: number;
  updatedAt: number;
  nextMessage: number;
}

export interface CrosstalkState {
  version: 2;
  pairs: Record<string, CrosstalkPair>;
  messages: CrosstalkMessage[];
}

export interface PairView {
  pair?: CrosstalkPair;
  selfSide?: PairSide;
  self?: PairEndpoint;
  buddy?: PairEndpoint;
  unread: CrosstalkMessage[];
  messages: CrosstalkMessage[];
}

export interface LocalSession {
  status: 'idle' | 'busy';
}

export interface WakeCandidate {
  sessionId: string;
  pairId: string;
  messageIds: string[];
  fromSide: PairSide;
}
