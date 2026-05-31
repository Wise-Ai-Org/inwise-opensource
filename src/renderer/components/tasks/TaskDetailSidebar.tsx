import React, { useState, useEffect, useRef } from 'react';
import {
  Drawer, DrawerBody, DrawerHeader, DrawerOverlay, DrawerContent, DrawerCloseButton,
  Box, Text, Badge, VStack, HStack, Divider, Avatar, Flex, Icon, Spinner, Checkbox,
  Button, Input, Textarea, Select, Progress, IconButton,
  useColorModeValue, useToast
} from '@chakra-ui/react';
import { WarningIcon, CheckIcon, CloseIcon, EditIcon, ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, RepeatIcon } from '@chakra-ui/icons';
import { MdUpdate, MdChat, MdPeople, MdAccountTree, MdVideoCall, MdChat as MdSlack, MdEmail, MdTask, MdSync } from 'react-icons/md';
import { FiGitPullRequest } from 'react-icons/fi';
import { api } from '../../api';
import { SELECT_PROPS, AiSuggestionBanner } from '../modal/FlowModalShell';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaskActivity {
  _id: string; userId: string; userName: string; action: string; timestamp: string; note?: string;
}
interface TaskComment {
  _id: string; userId: string; userName: string; message: string; createdAt: string;
}
interface RelatedTask {
  taskId: string; type: 'dependency' | 'related' | 'blocks' | 'blocked_by'; title?: string;
}
interface DetailedTask {
  _id: string; title: string; description?: string; status: string; priority: string;
  complexity?: string; estimate?: number; dueDate?: string | null; createdAt: string; updatedAt: string;
  source?: { type: string; url?: string };
  userId: string;
  assignee?: { name: string; userId: string };
  teamId?: string;
  team?: { name: string; members?: { userId: string; name: string; role: string }[] };
  keyResultId?: string | null;
  keyResult?: { _id: string; title: string; progress: number };
  epicId?: string | null;
  epic?: { _id: string; title: string; key?: string };
  objective?: { title: string; progress: number; status: string };
  blockerId?: string | null;
  blocker?: { title: string; status: string };
  activities?: TaskActivity[];
  comments?: TaskComment[];
  relatedTasks?: RelatedTask[];
  definition?: {
    outcome?: string;
    scope?: string;
    acceptanceCriteria?: string[];
    demoIdeas?: string[];
  };
  aiExtracted?: boolean;
  aiConfidence?: number;
  provenance?: {
    extractionMethod?: string;
    extractedAt?: string;
    meetingId?: string | null;
    transcriptId?: string | null;
    emailId?: string | null;
    slackThreadId?: string | null;
  };
  distillationSessionId?: string;
}

interface TaskDetailSidebarProps {
  taskId: string | null; isOpen: boolean; onClose: () => void;
  onEditClick: (task: DetailedTask) => void; onTaskUpdated: () => void;
}

const priorityColors: Record<string, string> = { low: 'gray', medium: 'blue', high: 'orange', critical: 'red' };
const statusColors: Record<string, string> = {
  todo: 'gray', in_progress: 'blue', inProgress: 'blue', completed: 'green', done: 'green', blocked: 'red', needs_review: 'orange'
};
const statusLabels: Record<string, string> = {
  todo: 'To Do', in_progress: 'In Progress', inProgress: 'In Progress',
  completed: 'Completed', done: 'Done', blocked: 'Blocked', needs_review: 'Needs Review'
};
const complexityColors: Record<string, string> = { XS: 'green', S: 'teal', M: 'blue', L: 'orange', XL: 'red' };

const sourceTypeIcons: Record<string, any> = {
  meeting_transcript: MdVideoCall, slack_message: MdSlack, email: MdEmail, jira_comment: MdTask
};
const sourceTypeLabels: Record<string, string> = {
  meeting_transcript: 'Meeting Transcript', slack_message: 'Slack Message', email: 'Email', jira_comment: 'JIRA Comment'
};
const sourceTypeColors: Record<string, string> = {
  meeting_transcript: 'purple', slack_message: 'blue', email: 'orange', jira_comment: 'green'
};

function getProgress(task: DetailedTask): number {
  if (task.keyResult?.progress != null) return task.keyResult.progress;
  const s = task.status?.toLowerCase();
  if (s === 'completed' || s === 'done') return 100;
  if (s === 'in_progress' || s === 'inprogress') return 50;
  return 0;
}
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

// ── Inline editable field ─────────────────────────────────────────────────

function InlineEdit({
  value, placeholder, type = 'text', options, isEditing: globalEditing, onSave, renderValue, aiHint
}: {
  value: string; placeholder: string; type?: 'text' | 'date' | 'number' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
  isEditing: boolean;
  onSave: (val: string) => Promise<void>;
  renderValue?: (val: string) => React.ReactNode;
  aiHint?: { label: string; confidence: number } | null;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [localEditing, setLocalEditing] = useState(false);
  const inputRef = useRef<any>(null);

  const isActive = globalEditing || localEditing;

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (isActive && inputRef.current) inputRef.current.focus();
  }, [isActive]);

  const handleSave = async () => {
    if (draft === value) { setLocalEditing(false); return; }
    setSaving(true);
    try { await onSave(draft); setLocalEditing(false); }
    finally { setSaving(false); }
  };

  const handleCancel = () => { setDraft(value); setLocalEditing(false); };

  if (isActive) {
    return (
      <HStack spacing={2} align="center" flex={1}>
        {type === 'textarea' ? (
          <Textarea ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} size="sm" rows={3}
            borderRadius="8px" fontSize="13px" borderColor="#9dd4d9"
            _focus={{ borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }}
            onKeyDown={e => { if (e.key === 'Escape') handleCancel(); }} />
        ) : type === 'select' && options ? (
          <Select ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} size="sm" flex={1} {...SELECT_PROPS}>
            <option value="">-- {placeholder} --</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        ) : (
          <Input ref={inputRef} type={type} value={draft} onChange={e => setDraft(e.target.value)} size="sm"
            flex={1} borderRadius="8px" fontSize="13px" borderColor="#9dd4d9"
            _focus={{ borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }} />
        )}
        <Box as="button" onClick={handleSave} color="#1a7080" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }} flexShrink={0}>
          {saving ? <Spinner size="xs" color="#1a7080" /> : <CheckIcon boxSize="14px" />}
        </Box>
        <Box as="button" onClick={handleCancel} color="gray.400" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }} flexShrink={0}>
          <CloseIcon boxSize="13px" />
        </Box>
      </HStack>
    );
  }

  return (
    <HStack spacing={2} align="center" cursor="pointer" onClick={() => setLocalEditing(true)}
      px={2} py={1} borderRadius="6px" _hover={{ bg: 'gray.50' }} flex={1}>
      {value
        ? (renderValue ? renderValue(value) : <Text fontSize="13px" color="gray.700">{value}</Text>)
        : <Text fontSize="13px" color="gray.400">{placeholder}</Text>
      }
      {aiHint && aiHint.confidence > 0.4 && (
        <Badge bg="#e8f4f5" color="#1a7080" fontSize="9px" borderRadius="full" px={1.5} flexShrink={0}>
          AI · {Math.round(aiHint.confidence * 100)}%
        </Badge>
      )}
    </HStack>
  );
}

// ── Communication trace ───────────────────────────────────────────────────

function CommTrace({ task }: { task: DetailedTask }) {
  const cardBg = useColorModeValue('purple.50', 'purple.900');
  const cardBorder = useColorModeValue('purple.200', 'purple.700');
  const labelColor = useColorModeValue('gray.500', 'gray.400');

  if (!task.aiExtracted || !task.source) return null;

  let sourceType = 'meeting_transcript';
  if (task.provenance?.slackThreadId) sourceType = 'slack_message';
  else if (task.provenance?.emailId) sourceType = 'email';

  const sourceId = task.provenance?.transcriptId || task.provenance?.meetingId
    || task.provenance?.slackThreadId || task.provenance?.emailId;

  const extractedAt = task.provenance?.extractedAt
    ? new Date(task.provenance.extractedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  const confidence = task.aiConfidence != null ? Math.round(task.aiConfidence * 100) : null;

  return (
    <Box p={3} bg={cardBg} border="1px solid" borderColor={cardBorder} borderRadius="lg">
      <HStack justify="space-between" mb={3}>
        <HStack spacing={3}>
          <Flex w="36px" h="36px" borderRadius="lg" bg="purple.100" align="center" justify="center" flexShrink={0}>
            <Icon as={sourceTypeIcons[sourceType] || MdVideoCall} color="purple.600" boxSize={5} />
          </Flex>
          <VStack align="start" spacing={0}>
            <Text fontSize="sm" fontWeight="semibold">{sourceTypeLabels[sourceType]}</Text>
            {extractedAt && <Text fontSize="xs" color={labelColor}>{extractedAt}</Text>}
          </VStack>
        </HStack>
        {task.distillationSessionId && (
          <Badge colorScheme={sourceTypeColors[sourceType]} borderRadius="full" px={3} py={0.5} fontSize="xs">
            1 SOURCE
          </Badge>
        )}
      </HStack>

      <Divider borderColor="purple.200" mb={3} />

      <HStack spacing={2} mb={3}>
        <Badge variant="outline" colorScheme="purple" fontSize="xs" px={2}>
          TYPE: {task.source.type === 'meeting' ? 'ACTION_ITEM' : task.source.type.toUpperCase()}
        </Badge>
        {confidence != null && (
          <Badge variant="outline" colorScheme="teal" fontSize="xs" px={2}>
            CONFIDENCE: {confidence}%
          </Badge>
        )}
      </HStack>

      <Text fontSize="sm" mb={3}>{task.title}</Text>

      {sourceId && (
        <Text fontSize="xs" color="blue.400">Source ID: {sourceId}</Text>
      )}
    </Box>
  );
}

// ── Chain node ────────────────────────────────────────────────────────────

function ChainNode({ label, title, color, isLast, isCurrent }: {
  label: string; title: string; color: string; isLast: boolean; isCurrent?: boolean;
}) {
  const labelColor = useColorModeValue('gray.500', 'gray.400');
  const nodeBg = useColorModeValue('white', 'gray.800');
  const lineBg = useColorModeValue('gray.200', 'gray.600');
  const currentBg = useColorModeValue('gray.100', 'gray.700');
  const currentBorder = useColorModeValue('gray.200', 'gray.600');
  return (
    <Flex align="stretch" minH="36px">
      <Flex direction="column" align="center" w="20px" flexShrink={0} mr={3}>
        <Box w="10px" h="10px" borderRadius="full" bg={color} mt="13px" flexShrink={0} />
        {!isLast && <Box flex={1} w="2px" bg={lineBg} mt={1} />}
      </Flex>
      <Box flex={1} py={1.5} px={2} mb={isLast ? 0 : 1} borderRadius="md"
        bg={isCurrent ? currentBg : nodeBg}
        border={isCurrent ? '1px solid' : undefined}
        borderColor={isCurrent ? currentBorder : undefined}>
        <Text fontSize="2xs" color={color} fontWeight="semibold" textTransform="uppercase" letterSpacing="wider">{label}</Text>
        <Text fontSize="sm" fontWeight={isCurrent ? 'semibold' : 'normal'} color={labelColor} noOfLines={1}>{title}</Text>
      </Box>
    </Flex>
  );
}

function Section({ label, icon, children }: { label: string; icon?: any; children: React.ReactNode }) {
  const labelColor = useColorModeValue('gray.500', 'gray.400');
  return (
    <Box px={5} py={4}>
      <HStack mb={3} spacing={2}>
        {icon && <Icon as={icon} color={labelColor} boxSize={4} />}
        <Text fontSize="sm" fontWeight="semibold">{label}</Text>
      </HStack>
      {children}
    </Box>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  const labelColor = useColorModeValue('gray.500', 'gray.400');
  return (
    <Flex justify="space-between" align="center" py={1}>
      <Text fontSize="sm" color={labelColor} flexShrink={0} mr={4}>{label}</Text>
      <Box>{children}</Box>
    </Flex>
  );
}

// ── SoR sync history (US-004) ─────────────────────────────────────────────

type SorOp = 'create' | 'update' | 'transition' | 'comment';
type SorResult = 'pending' | 'success' | 'failed' | 'pending-approval' | 'retrying';
type SorSystem = 'jira';

interface SorFieldDiff { field: string; before: any; after: any }
interface SorSpan { start: number; end: number; snippet: string }

interface SorWriteEntry {
  _id: string;
  targetSystem: SorSystem;
  targetRecordId: string;
  targetRecordUrl: string | null;
  operation: SorOp;
  fieldDiffs: SorFieldDiff[];
  commentBody: string | null;
  sourceMeetingId: string | null;
  sourceTranscriptSpan: SorSpan | null;
  linkedTaskId: string | null;
  confidence: number | null;
  approvalPath: 'auto' | 'user' | 'opt-in-gated';
  result: SorResult;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
}

const SOR_OP_META: Record<SorOp, { label: string; color: string }> = {
  create:     { label: 'Created',      color: 'green'  },
  update:     { label: 'Updated',      color: 'blue'   },
  transition: { label: 'Transitioned', color: 'purple' },
  comment:    { label: 'Commented',    color: 'gray'   },
};

function sorOneLineSummary(entry: SorWriteEntry): string {
  if (entry.operation === 'create') return 'New issue created';
  if (entry.operation === 'comment') return 'Comment added';
  if (entry.operation === 'transition') {
    const d = entry.fieldDiffs.find(f => f.field === 'status');
    if (d) return `Status: ${d.before ?? '—'} → ${d.after ?? '—'}`;
    return 'Status transition';
  }
  const n = entry.fieldDiffs.length;
  if (n === 0) return 'No field changes';
  if (n === 1) return `${entry.fieldDiffs[0].field} changed`;
  return `+${n} fields`;
}

const SYNC_HISTORY_PAGE_SIZE = 50;

function SyncHistory({ taskId }: { taskId: string }) {
  const [entries, setEntries] = useState<SorWriteEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const toast = useToast();
  const labelColor = useColorModeValue('gray.500', 'gray.400');

  const load = async () => {
    try {
      const rows = await api.sorListByTaskId(taskId);
      setEntries(Array.isArray(rows) ? (rows as SorWriteEntry[]) : []);
    } catch {
      setEntries([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    setLoaded(false);
    setExpandedId(null);
    setShowAll(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Live-refresh: re-query when a write completes for this task.
  useEffect(() => {
    const onWriteCompleted = (entry: SorWriteEntry) => {
      if (entry?.linkedTaskId === taskId) load();
    };
    api.on('sor:write-completed', onWriteCompleted);
    return () => { api.off('sor:write-completed', onWriteCompleted); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const retryOne = async (id: string) => {
    setRetryingId(id);
    try {
      await api.sorRetry(id);
    } catch (err: any) {
      toast({
        title: 'Retry failed',
        description: err?.message || 'Unknown error',
        status: 'error',
        duration: 3000,
      });
    } finally {
      setRetryingId(null);
    }
  };

  if (!loaded) {
    return (
      <Section label="Sync history" icon={MdSync}>
        <Flex justify="center" py={4}><Spinner size="sm" /></Flex>
      </Section>
    );
  }

  if (entries.length === 0) {
    return (
      <Section label="Sync history" icon={MdSync}>
        <Text fontSize="13px" color={labelColor}>
          No Jira sync yet. Auto-push runs when this task is updated or after the next meeting referencing it.
        </Text>
      </Section>
    );
  }

  // Derive header info from the most recent entry with a real targetRecordId.
  const mostRecent = entries[0];
  const keyedEntry = entries.find(e => e.targetRecordId && e.targetRecordId !== '(pending-create)') || mostRecent;
  const jiraKey = keyedEntry.targetRecordId && keyedEntry.targetRecordId !== '(pending-create)'
    ? keyedEntry.targetRecordId
    : null;
  const jiraUrl = keyedEntry.targetRecordUrl || null;
  const lastWriteAt = mostRecent.createdAt;

  const visibleEntries = showAll ? entries : entries.slice(0, SYNC_HISTORY_PAGE_SIZE);
  const hasMore = entries.length > SYNC_HISTORY_PAGE_SIZE;

  return (
    <Section label="Sync history" icon={MdSync}>
      {/* Header row: Jira key + last write + total count */}
      <HStack spacing={2} flexWrap="wrap" mb={3} fontSize="13px" color={labelColor}>
        <Text as="span">Synced to</Text>
        {jiraKey ? (
          <Box
            as="button"
            onClick={() => { if (jiraUrl) api.openExternal(jiraUrl); }}
            color="#1a7080"
            fontWeight="600"
            cursor={jiraUrl ? 'pointer' : 'default'}
            _hover={{ textDecoration: jiraUrl ? 'underline' : 'none' }}
          >
            {jiraKey}
            {jiraUrl && <ExternalLinkIcon boxSize="10px" ml={1} mb="2px" />}
          </Box>
        ) : (
          <Text as="span" color={labelColor}>Jira</Text>
        )}
        <Text as="span" color={labelColor}>·</Text>
        <Text as="span">last write {formatRelativeTime(lastWriteAt)}</Text>
        <Text as="span" color={labelColor}>·</Text>
        <Text as="span">{entries.length} {entries.length === 1 ? 'write' : 'writes'} total</Text>
      </HStack>

      <VStack align="stretch" spacing={2}>
        {visibleEntries.map(entry => {
          const meta = SOR_OP_META[entry.operation];
          const isExpanded = expandedId === entry._id;
          const isFailed = entry.result === 'failed';
          const isPending = entry.result === 'pending' || entry.result === 'retrying' || entry.result === 'pending-approval';

          return (
            <Box
              key={entry._id}
              p={3}
              borderRadius="8px"
              border="1px solid"
              borderColor={isFailed ? 'red.200' : 'gray.200'}
              bg={isFailed ? 'red.50' : 'white'}
            >
              <HStack spacing={3} align="flex-start">
                <Box
                  as="button"
                  onClick={() => setExpandedId(isExpanded ? null : entry._id)}
                  color="gray.400"
                  cursor="pointer"
                  lineHeight={0}
                  mt="2px"
                  _hover={{ color: 'gray.600' }}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <ChevronDownIcon boxSize="16px" /> : <ChevronRightIcon boxSize="16px" />}
                </Box>

                <VStack align="stretch" spacing={1} flex={1} minW={0}>
                  <HStack spacing={2} flexWrap="wrap">
                    <Badge colorScheme={meta.color} variant="subtle" fontSize="10px" borderRadius="full" px={2}>
                      {meta.label}
                    </Badge>
                    {entry.targetRecordId && entry.targetRecordId !== '(pending-create)' && (
                      <Box
                        as="button"
                        onClick={(e: any) => {
                          e.stopPropagation();
                          if (entry.targetRecordUrl) api.openExternal(entry.targetRecordUrl);
                        }}
                        color="#1a7080"
                        fontSize="12px"
                        fontWeight="600"
                        cursor={entry.targetRecordUrl ? 'pointer' : 'default'}
                        _hover={{ textDecoration: entry.targetRecordUrl ? 'underline' : 'none' }}
                      >
                        {entry.targetRecordId}
                        {entry.targetRecordUrl && <ExternalLinkIcon boxSize="10px" ml={1} mb="2px" />}
                      </Box>
                    )}
                    {isFailed && (
                      <Badge colorScheme="red" variant="subtle" fontSize="10px" borderRadius="full" px={2}>
                        Failed
                      </Badge>
                    )}
                    {isPending && (
                      <Badge colorScheme="yellow" variant="subtle" fontSize="10px" borderRadius="full" px={2}>
                        {entry.result === 'pending-approval' ? 'Pending approval' : 'In progress'}
                      </Badge>
                    )}
                    <Text fontSize="10px" color="gray.400">{formatRelativeTime(entry.createdAt)}</Text>
                    {entry.retryCount > 0 && (
                      <Text fontSize="10px" color="gray.400">retry #{entry.retryCount}</Text>
                    )}
                  </HStack>

                  <Text fontSize="13px" color="gray.700" noOfLines={isExpanded ? undefined : 1}>
                    {sorOneLineSummary(entry)}
                  </Text>

                  {isFailed && entry.errorMessage && !isExpanded && (
                    <Text fontSize="11px" color="red.600" noOfLines={1}>{entry.errorMessage}</Text>
                  )}

                  {isExpanded && (
                    <VStack align="stretch" spacing={2} mt={2} pt={2} borderTop="1px solid" borderColor="gray.100">
                      {entry.operation === 'comment' && entry.commentBody && (
                        <Box
                          bg="gray.50"
                          borderRadius="6px"
                          p={2}
                          fontSize="12px"
                          color="gray.700"
                          whiteSpace="pre-wrap"
                        >
                          {entry.commentBody}
                        </Box>
                      )}

                      {entry.operation !== 'comment' && entry.fieldDiffs.length > 0 && (
                        <Box fontSize="12px">
                          <Text fontSize="10px" fontWeight="600" color="gray.400" textTransform="uppercase" letterSpacing="0.05em" mb={1}>
                            Field changes
                          </Text>
                          <VStack align="stretch" spacing={1}>
                            {entry.fieldDiffs.map((d, i) => (
                              <HStack key={i} spacing={2} align="flex-start">
                                <Text color="gray.500" minW="80px" fontWeight="500">{d.field}</Text>
                                <HStack spacing={1} flex={1} flexWrap="wrap">
                                  <Text color="gray.500" textDecoration={entry.operation === 'create' ? 'none' : 'line-through'}>
                                    {d.before === null || d.before === undefined ? '—' : String(d.before)}
                                  </Text>
                                  <Text color="gray.400">→</Text>
                                  <Text color="gray.800">
                                    {d.after === null || d.after === undefined ? '—' : String(d.after)}
                                  </Text>
                                </HStack>
                              </HStack>
                            ))}
                          </VStack>
                        </Box>
                      )}

                      {entry.sourceTranscriptSpan?.snippet && (
                        <Box>
                          <Text fontSize="10px" fontWeight="600" color="gray.400" textTransform="uppercase" letterSpacing="0.05em" mb={1}>
                            From transcript
                          </Text>
                          <Box
                            borderLeft="3px solid"
                            borderLeftColor="#9dd4d9"
                            bg="#f0fafa"
                            pl={3}
                            py={2}
                            borderRadius="0 6px 6px 0"
                            fontSize="12px"
                            color="gray.700"
                            fontStyle="italic"
                          >
                            "{entry.sourceTranscriptSpan.snippet}"
                          </Box>
                        </Box>
                      )}

                      {isFailed && entry.errorMessage && (
                        <Box
                          bg="red.50"
                          border="1px solid"
                          borderColor="red.200"
                          borderRadius="6px"
                          p={2}
                          fontSize="12px"
                          color="red.700"
                        >
                          {entry.errorMessage}
                        </Box>
                      )}
                    </VStack>
                  )}
                </VStack>

                {isFailed && (
                  <Button
                    size="xs"
                    variant="outline"
                    colorScheme="red"
                    leftIcon={<RepeatIcon />}
                    onClick={() => retryOne(entry._id)}
                    isLoading={retryingId === entry._id}
                    flexShrink={0}
                  >
                    Retry
                  </Button>
                )}
              </HStack>
            </Box>
          );
        })}
      </VStack>

      {hasMore && !showAll && (
        <Text
          fontSize="12px"
          color="#1a7080"
          mt={3}
          cursor="pointer"
          onClick={() => setShowAll(true)}
          _hover={{ textDecoration: 'underline' }}
        >
          Show older ({entries.length - SYNC_HISTORY_PAGE_SIZE} more)
        </Text>
      )}
    </Section>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function TaskDetailSidebar({
  taskId, isOpen, onClose, onEditClick, onTaskUpdated
}: TaskDetailSidebarProps) {
  const [task, setTask] = useState<DetailedTask | null>(null);
  const [loading, setLoading] = useState(false);
  const isEditing = false; // fields manage own edit state via click
  const [showAllActivities, setShowAllActivities] = useState(false);
  const toast = useToast();

  // AI suggestions — local state, gracefully handle missing IPC
  const [suggestions, setSuggestions] = useState<Record<string, any>>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const hasData = Object.values(suggestions).some(s => s?.value != null && s.value !== '');
  const noData = !suggestionsLoading && !hasData;

  const getSuggestion = (key: string): { value?: string; confidence: number } | undefined => suggestions[key];

  const dividerColor = useColorModeValue('gray.100', 'gray.700');
  const labelColor = useColorModeValue('gray.500', 'gray.400');
  const updateBg = useColorModeValue('blue.50', 'blue.900');
  const blockerBg = useColorModeValue('red.50', 'red.900');
  const blockerBorder = useColorModeValue('red.200', 'red.700');
  const depBg = useColorModeValue('gray.50', 'gray.700');
  const metaBg = useColorModeValue('gray.50', 'gray.750');
  const sectionBg = useColorModeValue('white', 'gray.800');

  useEffect(() => {
    if (isOpen && taskId) {
      setTask(null);
      setShowAllActivities(false);
      setSuggestions({});
      fetchTaskDetail(taskId);
    }
  }, [isOpen, taskId]);

  // Fetch AI suggestions (gracefully fail)
  useEffect(() => {
    if (!isOpen || !task) return;
    let cancelled = false;
    (async () => {
      setSuggestionsLoading(true);
      try {
        const result = await (api as any).suggestTaskFields?.({ task });
        if (!cancelled && result) setSuggestions(result);
      } catch {
        // suggestTaskFields IPC not available yet
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, task]);

  const fetchTaskDetail = async (id: string) => {
    setLoading(true);
    try {
      // Desktop: fetch all tasks and find the one (no single-task IPC)
      const tasks = await api.getTasks();
      const found = (tasks || []).find((t: any) => t._id === id);
      if (found) setTask(found);
    } catch (err) {
      console.error('Failed to fetch task:', err);
    } finally {
      setLoading(false);
    }
  };

  const storyPointOptions = [1, 2, 3, 5, 8, 13, 21].map(n => ({ value: String(n), label: `${n} pts` }));

  const saveField = async (field: string, value: any) => {
    if (!task) return;
    try {
      await api.updateTask(task._id, { [field]: value });
      setTask(prev => prev ? { ...prev, [field]: value } : prev);
      onTaskUpdated();
    } catch {
      toast({ title: 'Failed to save', status: 'error' });
      throw new Error('save failed');
    }
  };

  const progress = task ? getProgress(task) : 0;
  const visibleActivities = showAllActivities ? (task?.activities ?? []) : (task?.activities ?? []).slice(0, 1);

  return (
    <Drawer isOpen={isOpen} placement="right" onClose={onClose} size="md">
      <DrawerOverlay />
      <DrawerContent bg={sectionBg}>
        <DrawerCloseButton />

        <DrawerHeader borderBottomWidth="1px" borderColor={dividerColor} pb={4}>
          {loading ? <Spinner size="sm" /> : task ? (
            <VStack align="start" spacing={2} pr={8}>
              <InlineEdit
                value={task.title} placeholder="Add title" isEditing={false}
                onSave={val => saveField('title', val)}
                renderValue={val => <Text fontSize="lg" fontWeight="bold" lineHeight="short">{val}</Text>}
              />
              <HStack spacing={2} flexWrap="wrap">
                <InlineEdit
                  value={task.status} placeholder="Set status" type="select" isEditing={false}
                  options={[
                    { value: 'todo', label: 'To Do' }, { value: 'in_progress', label: 'In Progress' },
                    { value: 'needs_review', label: 'Needs Review' }, { value: 'blocked', label: 'Blocked' },
                    { value: 'completed', label: 'Completed' }, { value: 'done', label: 'Done' }
                  ]}
                  onSave={val => saveField('status', val)}
                  aiHint={getSuggestion('status')?.value && getSuggestion('status')!.value !== task.status ? { label: getSuggestion('status')!.value!, confidence: getSuggestion('status')!.confidence } : null}
                  renderValue={val => (
                    <Badge colorScheme={statusColors[val] || 'gray'} fontSize="xs" px={2} py={0.5} borderRadius="md" textTransform="uppercase">
                      {statusLabels[val] || val}
                    </Badge>
                  )}
                />
                {task.source?.type && (
                  <Badge variant="outline" fontSize="xs" px={2} py={0.5} borderRadius="md" colorScheme="gray">
                    {task.source.type === 'meeting' ? 'From meeting' : task.source.type === 'jira' ? 'JIRA' : task.source.type}
                  </Badge>
                )}
              </HStack>
            </VStack>
          ) : null}
        </DrawerHeader>

        <DrawerBody p={0} overflowY="auto">
          {loading && <Flex justify="center" align="center" h="200px"><Spinner /></Flex>}

          {!loading && task && (
            <VStack align="stretch" spacing={0} divider={<Divider borderColor={dividerColor} />}>

              {/* ── Metadata panel ── */}
              <Box px={5} py={4} bg={metaBg}>
                <AiSuggestionBanner isLoading={suggestionsLoading || loading} hasData={hasData} noData={noData} />
                <VStack align="stretch" spacing={2}>

                  <MetaRow label="Owner">
                    <InlineEdit value={task.assignee?.name || ''} placeholder="Add owner" isEditing={false}
                      onSave={val => saveField('assignee', { name: val, userId: task.assignee?.userId || '' })}
                      aiHint={getSuggestion('assignee')?.value && getSuggestion('assignee')!.value !== (task.assignee?.name || '') ? { label: getSuggestion('assignee')!.value!, confidence: getSuggestion('assignee')!.confidence } : null}
                      renderValue={val => (
                        <HStack spacing={2}><Avatar size="xs" name={val} /><Text fontSize="13px" fontWeight="medium">{val}</Text></HStack>
                      )} />
                  </MetaRow>

                  <MetaRow label="Team">
                    <InlineEdit value={task.teamId || ''} placeholder="Select team" type="text" isEditing={false}
                      onSave={val => saveField('teamId', val || null)}
                      renderValue={val => {
                        const team = task.team;
                        return team ? <Text fontSize="13px">{team.name}</Text> : <Text fontSize="13px">{val}</Text>;
                      }} />
                  </MetaRow>

                  <MetaRow label="Priority">
                    <InlineEdit value={task.priority} placeholder="Set priority" type="select" isEditing={false}
                      options={[
                        { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
                        { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' }
                      ]}
                      onSave={val => saveField('priority', val)}
                      aiHint={getSuggestion('priority')?.value && getSuggestion('priority')!.value !== task.priority ? { label: getSuggestion('priority')!.value!, confidence: getSuggestion('priority')!.confidence } : null}
                      renderValue={val => (
                        <Badge colorScheme={priorityColors[val]} borderRadius="full" px={2} fontSize="xs">
                          {val.charAt(0).toUpperCase() + val.slice(1)}
                        </Badge>
                      )} />
                  </MetaRow>

                  <MetaRow label="Complexity">
                    <InlineEdit value={task.complexity || ''} placeholder="Set complexity" type="select" isEditing={false}
                      options={[
                        { value: 'XS', label: 'XS' }, { value: 'S', label: 'S' },
                        { value: 'M', label: 'M' }, { value: 'L', label: 'L' }, { value: 'XL', label: 'XL' }
                      ]}
                      onSave={val => saveField('complexity', val)}
                      renderValue={val => (
                        <Badge colorScheme={complexityColors[val] || 'gray'} borderRadius="md" fontSize="xs">{val}</Badge>
                      )} />
                  </MetaRow>

                  <MetaRow label="Story Points">
                    <InlineEdit value={task.estimate != null ? String(task.estimate) : ''} placeholder="Set estimate"
                      type="select" isEditing={false}
                      options={storyPointOptions}
                      onSave={val => saveField('estimate', val ? Number(val) : null)}
                      renderValue={val => <Text fontSize="13px">{val} pts</Text>} />
                  </MetaRow>

                  <MetaRow label="Due Date">
                    <InlineEdit
                      value={task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : ''}
                      placeholder="Set due date" type="date" isEditing={false}
                      onSave={val => saveField('dueDate', new Date(val).toISOString())}
                      renderValue={val => <Text fontSize="sm">{formatDate(val)}</Text>} />
                  </MetaRow>

                  {/* Epic */}
                  <MetaRow label="Epic">
                    <InlineEdit
                      value={task.epicId || ''} placeholder="Link epic" type="text" isEditing={false}
                      onSave={val => saveField('epicId', val || null)}
                      renderValue={val => {
                        const epic = task.epic;
                        return epic ? (
                          <Text fontSize="13px" color="purple.600">
                            {epic.key ? `[${epic.key}] ` : ''}{epic.title}
                          </Text>
                        ) : <Text fontSize="13px">{val}</Text>;
                      }} />
                  </MetaRow>

                  <MetaRow label="Key Result">
                    <InlineEdit
                      value={task.keyResultId || ''} placeholder="Link key result" type="text" isEditing={false}
                      onSave={val => saveField('keyResultId', val || null)}
                      renderValue={val => {
                        const kr = task.keyResult;
                        return kr ? (
                          <Text fontSize="13px" color="green.600" maxW="160px" noOfLines={1}>{kr.title}</Text>
                        ) : <Text fontSize="13px">{val}</Text>;
                      }} />
                  </MetaRow>

                </VStack>

                <Box mt={4}>
                  <Flex justify="space-between" mb={1}>
                    <Text fontSize="xs" color={labelColor} fontWeight="semibold" textTransform="uppercase" letterSpacing="wider">Progress</Text>
                    <Text fontSize="xs" color={labelColor}>{progress}%</Text>
                  </Flex>
                  <Progress value={progress} size="sm" colorScheme="brand" borderRadius="full" />
                </Box>
              </Box>

              {/* ── Description ── */}
              <Box px={5} py={4}>
                <Text fontSize="xs" fontWeight="semibold" color={labelColor} mb={2} textTransform="uppercase" letterSpacing="wider">
                  Description
                </Text>
                <InlineEdit value={task.description || ''} placeholder="Add a description..." type="textarea"
                  isEditing={false}
                  onSave={val => saveField('description', val)}
                  renderValue={val => <Text fontSize="sm" color="gray.700" whiteSpace="pre-wrap">{val}</Text>} />
              </Box>

              {/* ── Definition of Done ── */}
              {task.definition && (task.definition.acceptanceCriteria?.length || task.definition.outcome) ? (
                <Box px={5} py={4}>
                  <Text fontSize="xs" fontWeight="semibold" color={labelColor} mb={3} textTransform="uppercase" letterSpacing="wider">
                    Definition of Done
                  </Text>
                  <VStack align="stretch" spacing={2}>
                    {task.definition.outcome && (
                      <Box px={3} py={2} bg="gray.50" borderRadius="8px" borderLeft="3px solid" borderLeftColor="#1a7080">
                        <Text fontSize="10px" fontWeight="700" color="#1a7080" textTransform="uppercase" letterSpacing="0.06em" mb="2px">Outcome</Text>
                        <Text fontSize="13px" color="gray.700">{task.definition.outcome}</Text>
                      </Box>
                    )}
                    {task.definition.scope && (
                      <Box px={3} py={2} bg="gray.50" borderRadius="8px">
                        <Text fontSize="10px" fontWeight="700" color="gray.500" textTransform="uppercase" letterSpacing="0.06em" mb="2px">Scope</Text>
                        <Text fontSize="13px" color="gray.700">{task.definition.scope}</Text>
                      </Box>
                    )}
                    {task.definition.acceptanceCriteria && task.definition.acceptanceCriteria.length > 0 && (
                      <Box>
                        <Text fontSize="10px" fontWeight="700" color="gray.500" textTransform="uppercase" letterSpacing="0.06em" mb="6px">Criteria</Text>
                        <VStack align="stretch" spacing={1}>
                          {task.definition.acceptanceCriteria.map((criterion, idx) => (
                            <HStack key={idx} spacing={2} px={1}>
                              <Checkbox size="sm" colorScheme="teal" isReadOnly={task.status === 'completed' || task.status === 'done'} />
                              <Text fontSize="13px" color="gray.700">{criterion}</Text>
                            </HStack>
                          ))}
                        </VStack>
                      </Box>
                    )}
                  </VStack>
                </Box>
              ) : null}

              {/* ── Communication Trace ── */}
              {task.aiExtracted && (
                <Section label="Communication Trace">
                  <CommTrace task={task} />
                </Section>
              )}

              {/* ── Last Update / Activities ── */}
              {(task.activities?.length ?? 0) > 0 && (
                <Section label="Last Update" icon={MdUpdate}>
                  <VStack align="stretch" spacing={3}>
                    {visibleActivities.map((activity, idx) => (
                      <Box key={activity._id || idx} p={3} bg={updateBg} borderRadius="md">
                        <HStack justify="space-between" mb={1}>
                          <HStack spacing={2}>
                            <Avatar size="xs" name={activity.userName} />
                            <Text fontSize="sm" fontWeight="semibold">{activity.userName}</Text>
                          </HStack>
                          <Text fontSize="xs" color={labelColor}>{formatRelativeTime(activity.timestamp)}</Text>
                        </HStack>
                        <Text fontSize="sm" color="gray.600">{activity.action}</Text>
                        {activity.note && <Text fontSize="xs" color="gray.500" mt={1}>{activity.note}</Text>}
                      </Box>
                    ))}
                  </VStack>
                  {(task.activities?.length ?? 0) > 1 && (
                    <Text fontSize="xs" color="blue.500" mt={2} cursor="pointer"
                      onClick={() => setShowAllActivities(v => !v)}>
                      {showAllActivities ? 'Show less' : `Show recent updates (2-${task.activities!.length})`}
                    </Text>
                  )}
                </Section>
              )}

              {/* ── Blockers ── */}
              {task.blocker && (
                <Section label="Blockers" icon={WarningIcon}>
                  <Box p={3} bg={blockerBg} border="1px solid" borderColor={blockerBorder} borderRadius="md">
                    <Text fontSize="sm" fontWeight="semibold" color="red.700">{task.blocker.title}</Text>
                    {task.blocker.status && <Text fontSize="xs" color="red.500" mt={1}>Status: {task.blocker.status}</Text>}
                  </Box>
                </Section>
              )}

              {/* ── Dependencies ── */}
              {(task.relatedTasks?.length ?? 0) > 0 && (
                <Section label="Dependencies" icon={FiGitPullRequest}>
                  <VStack align="stretch" spacing={2}>
                    {task.relatedTasks!.map((rel) => {
                      const isBlockedBy = rel.type === 'blocked_by' || rel.type === 'dependency';
                      return (
                        <Flex key={rel.taskId} justify="space-between" align="center" p={3}
                          bg={depBg} borderRadius="md" borderLeft="3px solid"
                          borderLeftColor={isBlockedBy ? 'red.400' : 'blue.400'}>
                          <Text fontSize="sm" fontWeight="medium">{rel.title || rel.taskId}</Text>
                          <Badge colorScheme={isBlockedBy ? 'red' : 'blue'} fontSize="xs" borderRadius="md" px={2} flexShrink={0}>
                            {isBlockedBy ? 'Blocked by' : 'Blocking'}
                          </Badge>
                        </Flex>
                      );
                    })}
                  </VStack>
                </Section>
              )}

              {/* ── Conversation Thread ── */}
              {(task.comments?.length ?? 0) > 0 && (
                <Section label="Conversation" icon={MdChat}>
                  <VStack align="stretch" spacing={4}>
                    {task.comments!.map((comment) => (
                      <Box key={comment._id}>
                        <HStack justify="space-between" mb={1}>
                          <HStack spacing={2}>
                            <Avatar size="xs" name={comment.userName} />
                            <Text fontSize="sm" fontWeight="semibold">{comment.userName}</Text>
                          </HStack>
                          <Text fontSize="xs" color={labelColor}>{formatRelativeTime(comment.createdAt)}</Text>
                        </HStack>
                        <Text fontSize="sm" color="gray.600" pl={7}>{comment.message}</Text>
                      </Box>
                    ))}
                  </VStack>
                </Section>
              )}

              {/* ── Team Members ── */}
              {(task.team?.members?.length ?? 0) > 0 && (
                <Section label="Team Members" icon={MdPeople}>
                  <VStack align="stretch" spacing={3}>
                    {task.team!.members!.map((member) => (
                      <HStack key={member.userId} spacing={3}>
                        <Avatar size="sm" name={member.name} />
                        <VStack align="start" spacing={0}>
                          <Text fontSize="sm" fontWeight="semibold">{member.name}</Text>
                          <Text fontSize="xs" color={labelColor}>{member.role}</Text>
                        </VStack>
                      </HStack>
                    ))}
                  </VStack>
                </Section>
              )}

              {/* ── Linkage chain ── */}
              {(task.epic || task.keyResult || task.objective) && (
                <Section label="Linkage" icon={MdAccountTree}>
                  <VStack align="stretch" spacing={0}>
                    {task.objective && <ChainNode label="Objective" title={task.objective.title} color="purple.500" isLast={false} />}
                    {task.keyResult && <ChainNode label="Key Result" title={task.keyResult.title} color="green.500" isLast={!task.epic} />}
                    {task.epic && <ChainNode label="Epic" title={task.epic.key ? `[${task.epic.key}] ${task.epic.title}` : task.epic.title} color="blue.500" isLast={true} />}
                    <ChainNode label="This Task" title={task.title} color="gray.400" isLast={true} isCurrent />
                  </VStack>
                </Section>
              )}

              {/* ── SoR sync history (US-004) ── */}
              <SyncHistory taskId={task._id} />

            </VStack>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
