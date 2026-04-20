import React, { useState, useEffect, useMemo } from 'react';
import {
  Modal,
  Button,
  VStack,
  HStack,
  Text,
  Badge,
  Textarea,
  Input,
  Select,
  Box,
  Icon,
  IconButton,
  Spinner,
  Center,
  useToast,
  useColorModeValue
} from '@chakra-ui/react';
import { CheckIcon, CloseIcon } from '@chakra-ui/icons';
import { MdClose, MdUndo } from 'react-icons/md';
import { motion, LayoutGroup } from 'framer-motion';
import {
  FlowModalOverlay,
  FlowModalContent,
  FlowModalHeader,
  FlowModalBody,
  SELECT_PROPS
} from '../../components/modal/FlowModalShell';
import { api } from '../../api';

// ── Types ──────────────────────────────────────────────────────────────────

interface OwnerResolution {
  userId: string;
  userName: string;
  confidence: number;
  method: string;
}

interface ActionItem {
  id: string;
  taskId: string | null;
  text: string;
  owner: string;
  dueDate: string;
  confidence: number;
  selected: boolean;
  edited: boolean;
  originalText: string;
  originalOwner: string;
  originalDueDate: string;
  resolution: OwnerResolution | null;
  ownerOverridden: boolean;
}

interface BlockerItem {
  id: string;
  blockerId: string | null;
  text: string;
  severity: string;
  blockedItemId: string;
  blockedItemTitle: string;
  confidence: number;
  selected: boolean;
  edited: boolean;
  originalText: string;
  originalSeverity: string;
  originalBlockedItemId: string;
}

interface DecisionItem {
  id: string;
  text: string;
  relatedItemId: string;
  relatedItemTitle: string;
  confidence: number;
  selected: boolean;
  edited: boolean;
  originalText: string;
  originalRelatedItemId: string;
}

// ── Review Edit Ledger ────────────────────────────────────────────────────

interface FieldEdit {
  aiSuggested: string;
  aiConfidence: number;
  userFinal: string;
  action: 'accepted' | 'edited' | 'cleared';
}

interface ReviewEdit {
  itemId: string;
  itemType: 'actionItem' | 'blocker' | 'decision';
  meetingId: string;
  fields: Record<string, FieldEdit>;
  itemAction: 'approved' | 'dismissed';
}

interface Person {
  _id: string;
  name: string;
  email?: string;
}

// ── Props — matches what Communications.tsx passes ────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
  meetingId: string | null;
  onApproved: (meetingId: string) => void;
}

// ── Helper extractors ──────────────────────────────────────────────────────

function extractText(item: any): string {
  if (typeof item === 'string') return item;
  if (typeof item.content === 'string') return item.content;
  if (item.content && typeof item.content.item === 'string') return item.content.item;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.item === 'string') return item.item;
  if (typeof item.title === 'string') return item.title;
  if (typeof item.decision === 'string') return item.decision;
  return JSON.stringify(item);
}

function getContentObj(item: any): any {
  return item.content && typeof item.content === 'object' ? item.content : item;
}

function extractConfidence(item: any, defaultValue: number): number {
  const contentObj = getContentObj(item);
  if (typeof item.confidence === 'number') return item.confidence;
  if (typeof item.score === 'number') return item.score;
  if (typeof contentObj.confidence === 'number') return contentObj.confidence;
  return defaultValue;
}

function extractField(item: any, ...keys: string[]): string {
  const contentObj = getContentObj(item);
  for (const key of keys) {
    if (typeof contentObj[key] === 'string') return contentObj[key];
    if (typeof item[key] === 'string') return item[key];
  }
  return '';
}

// ── Simple height estimation (replaces pretext) ───────────────────────────

const LINE_H = 20;
const CARD_CHROME = 100;
const DISMISSED_H = 44;

function estimateHeight(text: string): number {
  // ~60 chars per line at 440px width with 13px font
  const lines = Math.max(1, Math.ceil(text.length / 60));
  return lines * LINE_H;
}

function cardHeight(textH: number): number {
  return textH + CARD_CHROME;
}

const CARD_SPRING = { type: 'spring' as const, stiffness: 340, damping: 28, mass: 0.8 };

// ── Confidence helpers ─────────────────────────────────────────────────────

function confTier(c: number): 'high' | 'medium' | 'low' {
  if (c >= 0.85) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
}

const CONF_STYLES = {
  high: { border: '#9dd4d9', bg: '#f0fafa', label: 'High confidence', badge: 'green', dot: '#1a7080' },
  medium: { border: '#e2e8f0', bg: 'white', label: 'Moderate', badge: 'blue', dot: '#3182CE' },
  low: { border: '#fbd38d', bg: '#fffff0', label: 'Needs review', badge: 'orange', dot: '#DD6B20' }
};

// ── Inline editable field ──────────────────────────────────────────────────

function InlineText({
  value,
  onChange,
  isEditing,
  onStartEdit,
  onConfirm,
  onCancel,
  measuredHeight,
  placeholder
}: {
  value: string;
  onChange: (v: string) => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  measuredHeight?: number;
  placeholder?: string;
}) {
  if (isEditing) {
    return (
      <VStack align="stretch" spacing={1} w="100%">
        <Textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          size="sm"
          rows={3}
          autoFocus
          borderColor="#9dd4d9"
          borderRadius="8px"
          fontSize="13px"
          lineHeight="20px"
          resize="none"
          minH={measuredHeight ? `${measuredHeight + 16}px` : undefined}
          _focus={{ borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }}
          placeholder={placeholder}
        />
        <HStack spacing={2} justify="flex-end">
          <Box as="button" onClick={onConfirm} color="#1a7080" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}>
            <CheckIcon boxSize="14px" />
          </Box>
          <Box as="button" onClick={onCancel} color="gray.400" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}>
            <CloseIcon boxSize="13px" />
          </Box>
        </HStack>
      </VStack>
    );
  }
  return (
    <Text
      fontSize="13px"
      lineHeight="20px"
      color="gray.800"
      cursor="pointer"
      _hover={{ bg: '#f7fafc', borderRadius: '6px' }}
      px={1}
      mx={-1}
      onClick={onStartEdit}
    >
      {value || <Text as="span" color="gray.400">{placeholder || 'Click to add...'}</Text>}
    </Text>
  );
}

function InlineField({
  label,
  value,
  displayValue,
  isEditing,
  onStartEdit,
  onConfirm,
  onCancel,
  children
}: {
  label: string;
  value: string;
  displayValue?: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Box flex={1}>
      {label && (
        <Text fontSize="10px" fontWeight="700" color="gray.400" textTransform="uppercase" letterSpacing="0.06em" mb="2px">
          {label}
        </Text>
      )}
      {isEditing ? (
        <HStack spacing={1}>
          <Box flex={1}>{children}</Box>
          <Box as="button" onClick={onConfirm} color="#1a7080" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}>
            <CheckIcon boxSize="14px" />
          </Box>
          <Box as="button" onClick={onCancel} color="gray.400" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}>
            <CloseIcon boxSize="13px" />
          </Box>
        </HStack>
      ) : (
        <Text
          fontSize="13px"
          color={value ? 'gray.700' : 'gray.400'}
          cursor="pointer"
          _hover={{ color: '#1a7080' }}
          onClick={onStartEdit}
        >
          {displayValue || value || 'Not set \u2014 click to add'}
        </Text>
      )}
    </Box>
  );
}

// ── Transcript parsing ─────────────────────────────────────────────────────

interface TranscriptTurn {
  speaker: string;
  timestamp: string;
  text: string;
}

function parseTranscript(text: string): TranscriptTurn[] {
  if (!text?.trim()) return [];

  // Format 1: Inline VTT-style
  const vttInlineRe = /(\d{2}:\d{2}:\d{2}[.,]\d+)\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d+)\s*\[([^\]]+)\]\s*/g;
  if (vttInlineRe.test(text)) {
    vttInlineRe.lastIndex = 0;
    const turns: TranscriptTurn[] = [];
    const parts: Array<{ start: string; speaker: string; text: string }> = [];
    let lastIdx = 0;
    let match;
    while ((match = vttInlineRe.exec(text)) !== null) {
      if (parts.length > 0 && match.index > lastIdx) {
        parts[parts.length - 1].text += text.slice(lastIdx, match.index).trim();
      }
      parts.push({ start: match[1], speaker: match[3], text: '' });
      lastIdx = match.index + match[0].length;
    }
    if (parts.length > 0 && lastIdx < text.length) {
      parts[parts.length - 1].text += text.slice(lastIdx).trim();
    }
    for (const p of parts) {
      const cleanText = p.text.replace(/\s+/g, ' ').trim();
      if (!cleanText) continue;
      const ts = p.start.replace(/,/g, '.').replace(/^(\d{2}:\d{2}:\d{2}).*/, '$1');
      const last = turns[turns.length - 1];
      if (last && last.speaker === p.speaker) {
        last.text += ' ' + cleanText;
      } else {
        turns.push({ speaker: p.speaker, timestamp: ts, text: cleanText });
      }
    }
    if (turns.length > 0) return turns;
  }

  // Format 2: Line-based
  const lines = text.split('\n');
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  const re = /^([A-Za-z][A-Za-z .'"-]{0,40}?)(?:\s*\(([^)]+)\))?\s*:\s*(.+)$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(re);
    if (m && m[3] && m[1].trim().split(' ').length <= 5) {
      if (current) turns.push(current);
      current = { speaker: m[1].trim(), timestamp: m[2]?.trim() || '', text: m[3].trim() };
    } else if (current) {
      current.text += ' ' + trimmed;
    } else {
      current = { speaker: '', timestamp: '', text: trimmed };
    }
  }
  if (current) turns.push(current);
  if (turns.length === 0) return [{ speaker: '', timestamp: '', text: text.trim() }];
  return turns;
}

// ── Highlight helpers ──────────────────────────────────────────────────────

type ItemType = 'action' | 'blocker' | 'decision';

interface HighlightSpan {
  start: number;
  end: number;
  type: ItemType;
}

const HIGHLIGHT_COLORS: Record<ItemType, { bg: string; border: string; color: string; label: string }> = {
  blocker:  { bg: '#fee2e2', border: '#fca5a5', color: '#c53030', label: 'Blockers' },
  action:   { bg: '#dbeafe', border: '#93c5fd', color: '#2b6cb0', label: 'Tasks' },
  decision: { bg: '#dcfce7', border: '#86efac', color: '#276749', label: 'Decisions' }
};

function buildSpans(text: string, phrases: Array<{ text: string; type: ItemType }>): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const lower = text.toLowerCase();
  for (const p of phrases) {
    const words = p.text.toLowerCase().split(/\s+/);
    let found = false;
    for (let len = Math.min(words.length, 6); len >= 3 && !found; len--) {
      for (let i = 0; i <= words.length - len && !found; i++) {
        const frag = words.slice(i, i + len).join(' ');
        const idx = lower.indexOf(frag);
        if (idx !== -1) {
          spans.push({ start: idx, end: idx + frag.length, type: p.type });
          found = true;
        }
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function HighlightedText({ text, phrases }: { text: string; phrases: Array<{ text: string; type: ItemType }> }) {
  const spans = buildSpans(text, phrases);
  if (!spans.length) return <>{text}</>;
  const segments: Array<{ text: string; span?: HighlightSpan }> = [];
  let pos = 0;
  for (const span of spans) {
    if (span.start < pos) continue;
    if (span.start > pos) segments.push({ text: text.slice(pos, span.start) });
    segments.push({ text: text.slice(span.start, span.end), span });
    pos = span.end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos) });
  return (
    <>
      {segments.map((seg, i) =>
        seg.span ? (
          <Box
            key={i}
            as="mark"
            display="inline"
            bg={HIGHLIGHT_COLORS[seg.span.type].bg}
            borderBottom="2px solid"
            borderColor={HIGHLIGHT_COLORS[seg.span.type].border}
            borderRadius="2px"
            px="1px"
          >
            {seg.text}
          </Box>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  );
}

// ── Tab config ─────────────────────────────────────────────────────────────

type ReviewTab = 'actionItems' | 'blockers' | 'decisions' | 'transcript';

const TAB_CONFIG = [
  { key: 'actionItems' as ReviewTab, label: 'Action Items' },
  { key: 'blockers' as ReviewTab, label: 'Blockers' },
  { key: 'decisions' as ReviewTab, label: 'Decisions' },
  { key: 'transcript' as ReviewTab, label: 'Transcript' }
];

function TabNav({
  activeTab,
  setActiveTab,
  counts
}: {
  activeTab: ReviewTab;
  setActiveTab: (t: ReviewTab) => void;
  counts: Record<ReviewTab, number>;
}) {
  return (
    <LayoutGroup id="review-tabs">
      <HStack spacing={0} borderBottom="1px solid" borderColor="gray.200">
        {TAB_CONFIG.map(tab => {
          const isActive = activeTab === tab.key;
          const count = counts[tab.key];
          return (
            <Box
              key={tab.key}
              flex={1}
              textAlign="center"
              cursor="pointer"
              onClick={() => setActiveTab(tab.key)}
              pb="10px"
              pt="4px"
              position="relative"
              sx={{ transition: 'color 0.15s' }}
            >
              <Text fontSize="13px" fontWeight={isActive ? '600' : '400'} color={isActive ? 'gray.800' : 'gray.400'}>
                {tab.label}
                {count > 0 && tab.key !== 'transcript' && (
                  <Text as="span" fontSize="11px" color={isActive ? 'gray.600' : 'gray.400'} ml={1}>
                    {count}
                  </Text>
                )}
              </Text>
              {isActive && (
                <motion.div
                  layoutId="review-tab-line"
                  style={{ position: 'absolute', bottom: 0, left: '20%', right: '20%', height: 2, background: '#3182CE', borderRadius: '2px 2px 0 0' }}
                />
              )}
            </Box>
          );
        })}
      </HStack>
    </LayoutGroup>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function TranscriptReviewModal({ isOpen, onClose, meetingId, onApproved }: Props) {
  const [loading, setLoading] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [suggestions, setSuggestions] = useState<{ actionItems: any[]; blockers: any[]; decisions: any[]; keyTopics: string[] } | null>(null);

  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [blockers, setBlockers] = useState<BlockerItem[]>([]);
  const [decisions, setDecisions] = useState<DecisionItem[]>([]);
  const [editingField, setEditingField] = useState<{ id: string; field: string } | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [activeTab, setActiveTab] = useState<ReviewTab>('actionItems');
  const [isApproving, setIsApproving] = useState(false);
  const [textHeights, setTextHeights] = useState<Record<string, number>>({});
  const [people, setPeople] = useState<Person[]>([]);

  const toast = useToast();
  const dimText = useColorModeValue('gray.500', 'gray.400');

  const transcriptTurns = useMemo(() => parseTranscript(transcript || ''), [transcript]);

  // ── Load meeting data + people list on open ───────────────────────────

  useEffect(() => {
    if (!isOpen || !meetingId) return;

    setLoading(true);
    setActiveTab('actionItems');
    setEditingField(null);

    Promise.all([
      api.getMeeting(meetingId),
      api.getPeople()
    ]).then(([meeting, peopleList]) => {
      setMeetingTitle(meeting?.title || 'Meeting Review');
      setTranscript(meeting?.transcript || '');
      setPeople(Array.isArray(peopleList) ? peopleList : []);

      const insights = meeting?.insights || {};
      const rawSuggestions = {
        actionItems: insights.actionItems || [],
        blockers: insights.blockers || [],
        decisions: insights.decisions || [],
        keyTopics: insights.keyTopics || insights.topics || []
      };
      setSuggestions(rawSuggestions);

      // Initialize items
      const heights: Record<string, number> = {};

      const newActions = (rawSuggestions.actionItems || []).map((item: any, idx: number) => {
        const text = extractText(item);
        const obj = getContentObj(item);
        const id = `action-${idx}`;
        const owner = obj.owner || item.owner || '';
        const dueDate = obj.deadline || item.deadline || obj.dueDate || item.dueDate || '';
        heights[id] = estimateHeight(text);
        return {
          id,
          taskId: obj.taskId || item.taskId || null,
          text,
          owner,
          dueDate,
          confidence: extractConfidence(item, 0.85),
          selected: true,
          edited: false,
          originalText: text,
          originalOwner: owner,
          originalDueDate: dueDate,
          resolution: obj.resolution || item.resolution || null,
          ownerOverridden: false
        };
      });

      const newBlockers = (rawSuggestions.blockers || []).map((item: any, idx: number) => {
        const text = extractText(item);
        const obj = getContentObj(item);
        const id = `blocker-${idx}`;
        const severity = extractField(item, 'severity') || 'medium';
        const blockedItemId = obj.blockedItemId || item.blockedItemId || '';
        heights[id] = estimateHeight(text);
        return {
          id,
          blockerId: obj.blockerId || item.blockerId || null,
          text,
          severity,
          blockedItemId,
          blockedItemTitle: obj.blockedItemTitle || item.blockedItemTitle || '',
          confidence: extractConfidence(item, 0.8),
          selected: true,
          edited: false,
          originalText: text,
          originalSeverity: severity,
          originalBlockedItemId: blockedItemId
        };
      });

      const newDecisions = (rawSuggestions.decisions || []).map((item: any, idx: number) => {
        const text = extractText(item);
        const obj = getContentObj(item);
        const id = `decision-${idx}`;
        const relatedItemId = obj.relatedItemId || item.relatedItemId || '';
        heights[id] = estimateHeight(text);
        return {
          id,
          text,
          relatedItemId,
          relatedItemTitle: obj.relatedItemTitle || item.relatedItemTitle || '',
          confidence: extractConfidence(item, 0.8),
          selected: true,
          edited: false,
          originalText: text,
          originalRelatedItemId: relatedItemId
        };
      });

      setActionItems(newActions);
      setBlockers(newBlockers);
      setDecisions(newDecisions);
      setTextHeights(heights);
    }).catch((err) => {
      toast({ title: 'Failed to load meeting', description: err?.message, status: 'error', duration: 3000 });
    }).finally(() => {
      setLoading(false);
    });
  }, [isOpen, meetingId]);

  // ── Editing helpers ────────────────────────────────────────────────────

  const startEdit = (id: string, field: string, currentValue: string) => {
    setEditingField({ id, field });
    setEditBuffer(currentValue);
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditBuffer('');
  };

  const isEditing = (id: string, field: string) =>
    editingField?.id === id && editingField?.field === field;

  // ── Item update helpers ────────────────────────────────────────────────

  const updateActionItem = (id: string, patch: Partial<ActionItem>) =>
    setActionItems(prev => prev.map(item =>
      item.id === id ? { ...item, ...patch, edited: 'text' in patch ? (patch.text !== item.originalText) : item.edited } : item
    ));

  const updateBlocker = (id: string, patch: Partial<BlockerItem>) =>
    setBlockers(prev => prev.map(item =>
      item.id === id ? { ...item, ...patch, edited: 'text' in patch ? (patch.text !== item.originalText) : item.edited } : item
    ));

  const updateDecision = (id: string, patch: Partial<DecisionItem>) =>
    setDecisions(prev => prev.map(item =>
      item.id === id ? { ...item, ...patch, edited: 'text' in patch ? (patch.text !== item.originalText) : item.edited } : item
    ));

  const dismissAction = (id: string) => setActionItems(prev => prev.map(i => i.id === id ? { ...i, selected: false } : i));
  const dismissBlocker = (id: string) => setBlockers(prev => prev.map(i => i.id === id ? { ...i, selected: false } : i));
  const dismissDecision = (id: string) => setDecisions(prev => prev.map(i => i.id === id ? { ...i, selected: false } : i));

  const restoreAction = (id: string) => setActionItems(prev => prev.map(i => i.id === id ? { ...i, selected: true } : i));
  const restoreBlocker = (id: string) => setBlockers(prev => prev.map(i => i.id === id ? { ...i, selected: true } : i));
  const restoreDecision = (id: string) => setDecisions(prev => prev.map(i => i.id === id ? { ...i, selected: true } : i));

  // ── Review Edit Ledger (captured locally, no remote endpoint) ─────────

  function fieldEdit(original: string, current: string, confidence: number): FieldEdit {
    const action = !current ? 'cleared' : current === original ? 'accepted' : 'edited';
    return { aiSuggested: original, aiConfidence: confidence, userFinal: current, action };
  }

  function buildReviewEdits(): ReviewEdit[] {
    const edits: ReviewEdit[] = [];

    for (const item of actionItems) {
      edits.push({
        itemId: item.taskId || item.id,
        itemType: 'actionItem',
        meetingId: meetingId!,
        fields: {
          text: fieldEdit(item.originalText, item.text, item.confidence),
          owner: fieldEdit(item.originalOwner, item.owner, item.resolution?.confidence || item.confidence),
          dueDate: fieldEdit(item.originalDueDate, item.dueDate, item.confidence)
        },
        itemAction: item.selected ? 'approved' : 'dismissed'
      });
    }

    for (const item of blockers) {
      edits.push({
        itemId: item.blockerId || item.id,
        itemType: 'blocker',
        meetingId: meetingId!,
        fields: {
          text: fieldEdit(item.originalText, item.text, item.confidence),
          severity: fieldEdit(item.originalSeverity, item.severity, item.confidence),
          blockedItemId: fieldEdit(item.originalBlockedItemId, item.blockedItemId, item.confidence)
        },
        itemAction: item.selected ? 'approved' : 'dismissed'
      });
    }

    for (const item of decisions) {
      edits.push({
        itemId: item.id,
        itemType: 'decision',
        meetingId: meetingId!,
        fields: {
          text: fieldEdit(item.originalText, item.text, item.confidence),
          relatedItemId: fieldEdit(item.originalRelatedItemId, item.relatedItemId, item.confidence)
        },
        itemAction: item.selected ? 'approved' : 'dismissed'
      });
    }

    return edits;
  }

  // ── Approve ────────────────────────────────────────────────────────────

  const handleApprove = async () => {
    if (!meetingId) return;
    setIsApproving(true);
    try {
      // Capture edit ledger (log locally for now — no remote endpoint on desktop)
      const reviewEdits = buildReviewEdits();
      console.log('[ReviewEdits]', reviewEdits);

      // Mark meeting as reviewed via IPC
      await api.reviewMeeting(meetingId);

      // Approve selected action items, reject dismissed ones
      const selectedActions = actionItems.filter(i => i.selected);
      const rejectedActions = actionItems.filter(i => !i.selected && i.taskId);

      for (const item of selectedActions) {
        if (item.taskId) {
          await api.updateTask(item.taskId, {
            title: item.text,
            assignee: item.owner || undefined,
            dueDate: item.dueDate || undefined,
            approval: { status: 'approved' }
          });
        } else {
          await api.createTask({
            title: item.text,
            assignee: item.owner || undefined,
            dueDate: item.dueDate || undefined,
            meetingId,
            source: 'meeting-review',
            approval: { status: 'approved' }
          });
        }
      }

      // Reject dismissed action items
      for (const item of rejectedActions) {
        await api.updateTask(item.taskId!, { approval: { status: 'rejected' } });
      }

      const totalSaved = selectedActions.length + blockers.filter(i => i.selected).length + decisions.filter(i => i.selected).length;

      // Auto-push to Jira if connected and enabled
      let jiraPushed = 0;
      try {
        const config = await api.getConfig();
        if (config.jiraAutoPush && config.jiraDefaultProject) {
          const jiraStatus = await api.jiraStatus?.();
          if (jiraStatus?.connected) {
            for (const item of selectedActions) {
              try {
                await api.jiraCreateIssue?.({
                  title: item.text,
                  description: `From meeting review\nOwner: ${item.owner || 'Unassigned'}`,
                  priority: 'medium',
                  projectKey: config.jiraDefaultProject,
                });
                jiraPushed++;
              } catch { /* skip individual failures */ }
            }
          }
        }
      } catch { /* Jira push is non-fatal */ }

      if (jiraPushed > 0) {
        toast({
          title: 'Meeting reviewed',
          description: `${totalSaved} item${totalSaved !== 1 ? 's' : ''} approved · ${jiraPushed} pushed to Jira`,
          status: 'success',
          duration: 4000
        });
      } else {
        const jiraConnected = await api.jiraStatus?.().then((s: any) => s?.connected).catch(() => false);
        toast({
          title: 'Meeting reviewed',
          description: jiraConnected
            ? `${totalSaved} item${totalSaved !== 1 ? 's' : ''} approved. Enable auto-sync in Settings to push to Jira.`
            : `${totalSaved} item${totalSaved !== 1 ? 's' : ''} approved. Connect to Jira in Settings to auto-push to Jira.`,
          status: 'success',
          duration: 5000
        });
      }

      onApproved(meetingId);
      onClose();
    } catch (err: any) {
      toast({
        title: 'Failed to save items',
        description: err?.message || 'Unknown error',
        status: 'error',
        duration: 5000,
        isClosable: true
      });
    } finally {
      setIsApproving(false);
    }
  };

  const selectedActions = actionItems.filter(i => i.selected);
  const selectedBlockers = blockers.filter(i => i.selected);
  const selectedDecisions = decisions.filter(i => i.selected);
  const totalSelected = selectedActions.length + selectedBlockers.length + selectedDecisions.length;
  const totalDismissed = (actionItems.length - selectedActions.length) + (blockers.length - selectedBlockers.length) + (decisions.length - selectedDecisions.length);

  const tabCounts: Record<ReviewTab, number> = {
    actionItems: actionItems.length,
    blockers: blockers.length,
    decisions: decisions.length,
    transcript: transcriptTurns.length
  };

  // ── Card renderers ─────────────────────────────────────────────────────

  const renderActionCard = (item: ActionItem) => {
    const tier = confTier(item.confidence);
    const style = CONF_STYLES[tier];
    const textH = textHeights[item.id] || LINE_H * 2;
    const fullH = cardHeight(textH);

    if (!item.selected) {
      return (
        <motion.div
          key={item.id}
          initial={{ height: fullH }}
          animate={{ height: DISMISSED_H, opacity: 0.6 }}
          transition={CARD_SPRING}
          style={{ overflow: 'hidden', borderRadius: 10 }}
        >
          <Box px={4} py={3} bg="gray.50" borderRadius="10px" border="1px dashed" borderColor="gray.200">
            <HStack justify="space-between">
              <Text fontSize="12px" color="gray.400" noOfLines={1}>{item.text}</Text>
              <Button size="xs" variant="ghost" color="gray.500" leftIcon={<Icon as={MdUndo} />} onClick={() => restoreAction(item.id)} flexShrink={0}>
                Restore
              </Button>
            </HStack>
          </Box>
        </motion.div>
      );
    }

    return (
      <motion.div
        key={item.id}
        animate={{ height: fullH, opacity: 1 }}
        transition={CARD_SPRING}
        style={{ overflow: 'hidden', borderRadius: 10 }}
      >
        <Box p={4} bg={style.bg} borderRadius="10px" borderLeft="3px solid" borderLeftColor={style.dot} border="1px solid" borderColor={style.border}>
          {/* Confidence + dismiss row */}
          <HStack justify="space-between" mb={2}>
            <HStack spacing={2}>
              <Box w="7px" h="7px" borderRadius="full" bg={style.dot} />
              <Badge colorScheme={style.badge} variant="subtle" fontSize="10px" borderRadius="full" px={2}>
                {Math.round(item.confidence * 100)}% {style.label.toLowerCase()}
              </Badge>
              {item.edited && <Badge colorScheme="orange" fontSize="10px" borderRadius="full" px={2}>Edited</Badge>}
            </HStack>
            <IconButton
              aria-label="Dismiss"
              icon={<Icon as={MdClose} />}
              size="xs"
              variant="ghost"
              color="gray.400"
              borderRadius="6px"
              onClick={() => dismissAction(item.id)}
            />
          </HStack>

          {/* Text — click to edit inline */}
          <Box mb={3}>
            <InlineText
              value={item.text}
              onChange={v => setEditBuffer(v)}
              isEditing={isEditing(item.id, 'text')}
              onStartEdit={() => startEdit(item.id, 'text', item.text)}
              onConfirm={() => { updateActionItem(item.id, { text: editBuffer }); cancelEdit(); }}
              onCancel={() => { cancelEdit(); }}
              measuredHeight={textHeights[item.id]}
            />
          </Box>

          {/* Owner + Due Date fields — inline editable */}
          <HStack spacing={4} align="flex-start">
            <Box flex={1}>
              <Text fontSize="10px" fontWeight="700" color="gray.400" textTransform="uppercase" letterSpacing="0.06em" mb="2px">
                Owner
              </Text>
              {item.resolution && !item.ownerOverridden && !isEditing(item.id, 'owner') ? (
                <HStack spacing={2}>
                  <Box w="6px" h="6px" borderRadius="full" bg="#1a7080" />
                  <Text fontSize="13px" fontWeight="500" color="gray.700">{item.resolution.userName}</Text>
                  <Badge colorScheme={item.resolution.confidence >= 0.9 ? 'green' : 'yellow'} variant="subtle" fontSize="9px">
                    {Math.round(item.resolution.confidence * 100)}% match
                  </Badge>
                  <Button
                    size="xs"
                    variant="ghost"
                    color="gray.400"
                    fontWeight="normal"
                    fontSize="11px"
                    onClick={() => { updateActionItem(item.id, { ownerOverridden: true }); startEdit(item.id, 'owner', item.owner); }}
                  >
                    Change
                  </Button>
                </HStack>
              ) : (
                <InlineField
                  label=""
                  value={item.owner}
                  isEditing={isEditing(item.id, 'owner')}
                  onStartEdit={() => startEdit(item.id, 'owner', item.owner)}
                  onConfirm={() => { updateActionItem(item.id, { owner: editBuffer }); cancelEdit(); }}
                  onCancel={cancelEdit}
                >
                  {people.length > 0 ? (
                    <Select
                      size="sm"
                      value={editBuffer}
                      onChange={e => setEditBuffer(e.target.value)}
                      placeholder="Select owner..."
                      autoFocus
                      {...SELECT_PROPS}
                    >
                      {people.map(p => (
                        <option key={p._id} value={p.name}>{p.name}{p.email ? ` (${p.email})` : ''}</option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      size="sm"
                      value={editBuffer}
                      onChange={e => setEditBuffer(e.target.value)}
                      placeholder="Assign owner..."
                      autoFocus
                      borderRadius="6px"
                      fontSize="13px"
                      borderColor="#9dd4d9"
                      _focus={{ borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }}
                    />
                  )}
                </InlineField>
              )}
            </Box>

            <InlineField
              label="Due"
              value={item.dueDate}
              displayValue={item.dueDate || 'No deadline'}
              isEditing={isEditing(item.id, 'dueDate')}
              onStartEdit={() => startEdit(item.id, 'dueDate', item.dueDate)}
              onConfirm={() => { updateActionItem(item.id, { dueDate: editBuffer }); cancelEdit(); }}
              onCancel={cancelEdit}
            >
              <Input
                size="sm"
                type="date"
                value={editBuffer}
                onChange={e => setEditBuffer(e.target.value)}
                autoFocus
                borderRadius="6px"
                fontSize="13px"
                borderColor="#9dd4d9"
                _focus={{ borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }}
              />
            </InlineField>
          </HStack>
        </Box>
      </motion.div>
    );
  };

  const renderBlockerCard = (item: BlockerItem) => {
    const tier = confTier(item.confidence);
    const style = CONF_STYLES[tier];
    const sevColor = item.severity === 'critical' ? 'red' : item.severity === 'high' ? 'orange' : 'yellow';
    const textH = textHeights[item.id] || LINE_H * 2;
    const fullH = cardHeight(textH);

    if (!item.selected) {
      return (
        <motion.div
          key={item.id}
          initial={{ height: fullH }}
          animate={{ height: DISMISSED_H, opacity: 0.6 }}
          transition={CARD_SPRING}
          style={{ overflow: 'hidden', borderRadius: 10 }}
        >
          <Box px={4} py={3} bg="gray.50" borderRadius="10px" border="1px dashed" borderColor="gray.200">
            <HStack justify="space-between">
              <Text fontSize="12px" color="gray.400" noOfLines={1}>{item.text}</Text>
              <Button size="xs" variant="ghost" color="gray.500" leftIcon={<Icon as={MdUndo} />} onClick={() => restoreBlocker(item.id)} flexShrink={0}>
                Restore
              </Button>
            </HStack>
          </Box>
        </motion.div>
      );
    }

    return (
      <motion.div
        key={item.id}
        animate={{ height: fullH, opacity: 1 }}
        transition={CARD_SPRING}
        style={{ overflow: 'hidden', borderRadius: 10 }}
      >
        <Box p={4} bg={style.bg} borderRadius="10px" borderLeft="3px solid" borderLeftColor="#fc8181" border="1px solid" borderColor={style.border}>
          <HStack justify="space-between" mb={2}>
            <HStack spacing={2}>
              <Badge colorScheme={sevColor} fontSize="10px" borderRadius="full" px={2}>{item.severity}</Badge>
              <Badge colorScheme={style.badge} variant="subtle" fontSize="10px" borderRadius="full" px={2}>
                {Math.round(item.confidence * 100)}%
              </Badge>
              {item.edited && <Badge colorScheme="orange" fontSize="10px" borderRadius="full" px={2}>Edited</Badge>}
            </HStack>
            <IconButton aria-label="Dismiss" icon={<Icon as={MdClose} />} size="xs" variant="ghost" color="gray.400" borderRadius="6px" onClick={() => dismissBlocker(item.id)} />
          </HStack>

          <Box mb={3}>
            <InlineText
              value={item.text}
              onChange={v => setEditBuffer(v)}
              isEditing={isEditing(item.id, 'text')}
              onStartEdit={() => startEdit(item.id, 'text', item.text)}
              onConfirm={() => { updateBlocker(item.id, { text: editBuffer }); cancelEdit(); }}
              onCancel={cancelEdit}
              measuredHeight={textHeights[item.id]}
            />
          </Box>

          <HStack spacing={4} align="flex-start">
            <InlineField
              label="Severity"
              value={item.severity}
              isEditing={isEditing(item.id, 'severity')}
              onStartEdit={() => startEdit(item.id, 'severity', item.severity)}
              onConfirm={() => { updateBlocker(item.id, { severity: editBuffer }); cancelEdit(); }}
              onCancel={cancelEdit}
            >
              <Select
                size="sm"
                value={editBuffer}
                onChange={e => setEditBuffer(e.target.value)}
                autoFocus
                {...SELECT_PROPS}
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
              </Select>
            </InlineField>

            <InlineField
              label="Blocks"
              value={item.blockedItemId}
              displayValue={item.blockedItemTitle || 'Not linked'}
              isEditing={isEditing(item.id, 'blocks')}
              onStartEdit={() => startEdit(item.id, 'blocks', item.blockedItemId)}
              onConfirm={() => {
                updateBlocker(item.id, { blockedItemId: editBuffer, blockedItemTitle: editBuffer });
                cancelEdit();
              }}
              onCancel={cancelEdit}
            >
              <Input
                size="sm"
                value={editBuffer}
                onChange={e => setEditBuffer(e.target.value)}
                placeholder="Link to item..."
                autoFocus
                borderRadius="6px"
                fontSize="13px"
                borderColor="#9dd4d9"
                _focus={{ borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }}
              />
            </InlineField>
          </HStack>
        </Box>
      </motion.div>
    );
  };

  const renderDecisionCard = (item: DecisionItem) => {
    const tier = confTier(item.confidence);
    const style = CONF_STYLES[tier];
    const textH = textHeights[item.id] || LINE_H * 2;
    const fullH = cardHeight(textH);

    if (!item.selected) {
      return (
        <motion.div
          key={item.id}
          initial={{ height: fullH }}
          animate={{ height: DISMISSED_H, opacity: 0.6 }}
          transition={CARD_SPRING}
          style={{ overflow: 'hidden', borderRadius: 10 }}
        >
          <Box px={4} py={3} bg="gray.50" borderRadius="10px" border="1px dashed" borderColor="gray.200">
            <HStack justify="space-between">
              <Text fontSize="12px" color="gray.400" noOfLines={1}>{item.text}</Text>
              <Button size="xs" variant="ghost" color="gray.500" leftIcon={<Icon as={MdUndo} />} onClick={() => restoreDecision(item.id)} flexShrink={0}>
                Restore
              </Button>
            </HStack>
          </Box>
        </motion.div>
      );
    }

    return (
      <motion.div
        key={item.id}
        animate={{ height: fullH, opacity: 1 }}
        transition={CARD_SPRING}
        style={{ overflow: 'hidden', borderRadius: 10 }}
      >
        <Box p={4} bg={style.bg} borderRadius="10px" borderLeft="3px solid" borderLeftColor="#68d391" border="1px solid" borderColor={style.border}>
          <HStack justify="space-between" mb={2}>
            <HStack spacing={2}>
              <Box w="7px" h="7px" borderRadius="full" bg="#68d391" />
              <Badge colorScheme={style.badge} variant="subtle" fontSize="10px" borderRadius="full" px={2}>
                {Math.round(item.confidence * 100)}%
              </Badge>
              {item.edited && <Badge colorScheme="orange" fontSize="10px" borderRadius="full" px={2}>Edited</Badge>}
            </HStack>
            <IconButton aria-label="Dismiss" icon={<Icon as={MdClose} />} size="xs" variant="ghost" color="gray.400" borderRadius="6px" onClick={() => dismissDecision(item.id)} />
          </HStack>

          <Box mb={3}>
            <InlineText
              value={item.text}
              onChange={v => setEditBuffer(v)}
              isEditing={isEditing(item.id, 'text')}
              onStartEdit={() => startEdit(item.id, 'text', item.text)}
              onConfirm={() => { updateDecision(item.id, { text: editBuffer }); cancelEdit(); }}
              onCancel={cancelEdit}
              measuredHeight={textHeights[item.id]}
            />
          </Box>

          <InlineField
            label="Relates to"
            value={item.relatedItemId}
            displayValue={item.relatedItemTitle || 'Not linked'}
            isEditing={isEditing(item.id, 'relatedTo')}
            onStartEdit={() => startEdit(item.id, 'relatedTo', item.relatedItemId)}
            onConfirm={() => {
              updateDecision(item.id, { relatedItemId: editBuffer, relatedItemTitle: editBuffer });
              cancelEdit();
            }}
            onCancel={cancelEdit}
          >
            <Input
              size="sm"
              value={editBuffer}
              onChange={e => setEditBuffer(e.target.value)}
              placeholder="Link to item..."
              autoFocus
              borderRadius="6px"
              fontSize="13px"
              borderColor="#9dd4d9"
              _focus={{ borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }}
            />
          </InlineField>
        </Box>
      </motion.div>
    );
  };

  // ── Transcript tab ─────────────────────────────────────────────────────

  const renderTranscriptTab = () => {
    if (!transcript) {
      return (
        <Box textAlign="center" py={10}>
          <Text color="gray.400" fontSize="sm">No transcript available for this meeting.</Text>
        </Box>
      );
    }

    const allPhrases: Array<{ text: string; type: ItemType }> = [
      ...actionItems.map(a => ({ text: a.text, type: 'action' as ItemType })),
      ...blockers.map(b => ({ text: b.text, type: 'blocker' as ItemType })),
      ...decisions.map(d => ({ text: d.text, type: 'decision' as ItemType }))
    ];

    return (
      <VStack spacing={4} align="stretch">
        {/* Legend */}
        <HStack spacing={5} justify="flex-end" pb={1}>
          {Object.entries(HIGHLIGHT_COLORS).map(([, c]) => (
            <HStack key={c.label} spacing={1.5}>
              <Box w="10px" h="10px" borderRadius="2px" bg={c.bg} border="1.5px solid" borderColor={c.border} />
              <Text fontSize="xs" color={c.color} fontWeight="medium">{c.label}</Text>
            </HStack>
          ))}
        </HStack>

        {transcriptTurns.map((turn, i) => {
          const turnPhrases = allPhrases.filter(p => {
            const frag = p.text.toLowerCase().split(/\s+/).slice(0, 5).join(' ');
            return frag.length > 8 && turn.text.toLowerCase().includes(frag);
          });
          const turnActions = actionItems.filter(a => { const f = a.text.toLowerCase().split(/\s+/).slice(0, 5).join(' '); return f.length > 8 && turn.text.toLowerCase().includes(f); });
          const turnBlockers = blockers.filter(b => { const f = b.text.toLowerCase().split(/\s+/).slice(0, 5).join(' '); return f.length > 8 && turn.text.toLowerCase().includes(f); });
          const turnDecisions = decisions.filter(d => { const f = d.text.toLowerCase().split(/\s+/).slice(0, 5).join(' '); return f.length > 8 && turn.text.toLowerCase().includes(f); });
          const hasExtracted = turnActions.length > 0 || turnBlockers.length > 0 || turnDecisions.length > 0;

          return (
            <Box
              key={i}
              px={5}
              py={4}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="12px"
              boxShadow="0 1px 3px rgba(0,0,0,0.04)"
            >
              {(turn.speaker || turn.timestamp) && (
                <HStack justify="space-between" mb={2}>
                  {turn.speaker && <Text fontSize="md" fontWeight="bold" color="gray.800">{turn.speaker}</Text>}
                  {turn.timestamp && <Text fontSize="xs" color="gray.400">{turn.timestamp}</Text>}
                </HStack>
              )}
              <Text fontSize="sm" lineHeight="1.8" color="gray.700">
                <HighlightedText text={turn.text} phrases={turnPhrases} />
              </Text>
              {hasExtracted && (
                <Box mt={3} pt={3} borderTop="1px solid" borderColor="gray.100">
                  <Text fontSize="10px" fontWeight="600" color="gray.400" textTransform="uppercase" letterSpacing="0.05em" mb={2}>Extracted Items:</Text>
                  <HStack spacing={2} flexWrap="wrap">
                    {turnBlockers.map((b, j) => (
                      <Badge key={`b-${j}`} bg={HIGHLIGHT_COLORS.blocker.bg} color={HIGHLIGHT_COLORS.blocker.color} borderRadius="full" px={2.5} py={0.5} fontSize="xs" fontWeight="medium" border="1px solid" borderColor={HIGHLIGHT_COLORS.blocker.border}>
                        {b.selected ? 'blocker' : 'blocker (dismissed)'}
                      </Badge>
                    ))}
                    {turnActions.map((a, j) => (
                      <Badge key={`a-${j}`} bg={HIGHLIGHT_COLORS.action.bg} color={HIGHLIGHT_COLORS.action.color} borderRadius="full" px={2.5} py={0.5} fontSize="xs" fontWeight="medium" border="1px solid" borderColor={HIGHLIGHT_COLORS.action.border}>
                        {a.owner ? `task \u2192 ${a.owner}` : 'task'}
                      </Badge>
                    ))}
                    {turnDecisions.map((_, j) => (
                      <Badge key={`d-${j}`} bg={HIGHLIGHT_COLORS.decision.bg} color={HIGHLIGHT_COLORS.decision.color} borderRadius="full" px={2.5} py={0.5} fontSize="xs" fontWeight="medium" border="1px solid" borderColor={HIGHLIGHT_COLORS.decision.border}>
                        decision
                      </Badge>
                    ))}
                  </HStack>
                </Box>
              )}
            </Box>
          );
        })}
      </VStack>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="6xl" scrollBehavior="inside" motionPreset="scale">
      <FlowModalOverlay />
      <FlowModalContent maxH="90vh" maxW="1100px" letterSpacing="-0.01em">
        <FlowModalHeader
          title="Review Extracted Items"
          subtitle={meetingTitle}
        />

        {loading ? (
          <Center py={16}>
            <Spinner size="lg" color="brand.500" />
          </Center>
        ) : !suggestions ? (
          <Center py={16}>
            <Text color="gray.400" fontSize="sm">No meeting data loaded.</Text>
          </Center>
        ) : (
          <>
            <Box px={7} pb={2}>
              <TabNav activeTab={activeTab} setActiveTab={setActiveTab} counts={tabCounts} />
            </Box>

            <FlowModalBody maxH="calc(80vh - 200px)">
              <VStack spacing={3} align="stretch" pb={16}>
                {/* Summary bar */}
                {activeTab !== 'transcript' && (
                  <Box bg="#f7fafc" borderRadius="8px" px={3} py={2}>
                    <Text fontSize="11px" color="gray.500">
                      AI extracted {tabCounts[activeTab]} item{tabCounts[activeTab] !== 1 ? 's' : ''} from this meeting.
                      {' '}Click any text to edit. Items are included by default — dismiss what you don&apos;t need.
                    </Text>
                  </Box>
                )}

                {/* Empty states */}
                {activeTab === 'actionItems' && actionItems.length === 0 && (
                  <Box textAlign="center" py={10}>
                    <Text color="gray.400" fontSize="sm">No action items extracted from this meeting.</Text>
                  </Box>
                )}
                {activeTab === 'blockers' && blockers.length === 0 && (
                  <Box textAlign="center" py={10}>
                    <Text color="gray.400" fontSize="sm">No blockers extracted from this meeting.</Text>
                  </Box>
                )}
                {activeTab === 'decisions' && decisions.length === 0 && (
                  <Box textAlign="center" py={10}>
                    <Text color="gray.400" fontSize="sm">No decisions extracted from this meeting.</Text>
                  </Box>
                )}

                {activeTab === 'actionItems' && actionItems.map(item => renderActionCard(item))}
                {activeTab === 'blockers' && blockers.map(item => renderBlockerCard(item))}
                {activeTab === 'decisions' && decisions.map(item => renderDecisionCard(item))}
                {activeTab === 'transcript' && renderTranscriptTab()}
              </VStack>
            </FlowModalBody>

            <Box px={7} py={4} borderTop="1px solid" borderColor="gray.100" bg="gray.50">
              <HStack justify="space-between" w="100%">
                <Text fontSize="xs" color={dimText}>
                  {totalSelected > 0 ? `${totalSelected} included` : 'No items selected'}
                  {totalDismissed > 0 ? ` \u00b7 ${totalDismissed} dismissed` : ''}
                </Text>
                <HStack spacing={2}>
                  <Button variant="ghost" size="sm" colorScheme="gray" fontSize="12px" onClick={onClose}>Cancel</Button>
                  <Button
                    size="sm"
                    bg="#1a7080"
                    color="white"
                    borderRadius="8px"
                    fontSize="12px"
                    _hover={{ bg: '#15606e' }}
                    leftIcon={<CheckIcon />}
                    onClick={handleApprove}
                    isLoading={isApproving}
                    isDisabled={totalSelected === 0}
                  >
                    Save {totalSelected > 0 ? `${totalSelected} Item${totalSelected !== 1 ? 's' : ''}` : ''}
                  </Button>
                </HStack>
              </HStack>
            </Box>
          </>
        )}
      </FlowModalContent>
    </Modal>
  );
}
