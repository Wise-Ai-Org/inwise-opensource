import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  Button,
  Input,
  Textarea,
  FormControl,
  Select,
  VStack,
  HStack,
  Box,
  Text,
  SimpleGrid,
  Badge,
  Spinner,
  FormHelperText
} from '@chakra-ui/react';
import { CheckIcon, CloseIcon } from '@chakra-ui/icons';
import { api } from '../../api';
import {
  FlowModalOverlay,
  FlowModalContent,
  FlowModalHeader,
  FlowModalBody,
  FlowModalFooter,
  FlowFormLabel,
  AiSuggestionBanner,
  fieldAnim,
  INPUT_PROPS,
  SELECT_PROPS,
  TEXTAREA_PROPS,
  motion
} from '../modal/FlowModalShell';

// ── Types ───────────────────────────────────────────────────────────────────

interface KeyResult { _id: string; title: string; progress: number }
interface Team { _id: string; name: string }
interface Epic { _id: string; title: string; key?: string }
interface User { _id: string; name: string; firstName?: string; lastName?: string }
interface TaskDefinition { outcome: string; scope: string; acceptanceCriteria: string[]; demoIdeas: string[] }

interface Suggestion { value?: string; confidence: number }
interface Suggestions { [key: string]: Suggestion }

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTaskCreated: () => void;
  defaultStatus?: 'todo' | 'inProgress' | 'completed';
}

// ── AI-suggested field display ──────────────────────────────────────────────

function SuggestedLabel({
  label,
  value,
  confidence,
  isEditing,
  onStartEdit,
  onConfirm,
  onCancel,
  children
}: {
  label: string;
  value: string;
  confidence?: number;
  isEditing: boolean;
  onStartEdit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const hasSuggestion = confidence && confidence > 0.4 && value;

  return (
    <FormControl>
      <FlowFormLabel>
        {label}
        {hasSuggestion && (
          <Text as="span" fontSize="9px" color="#1a7080" ml={2} fontWeight="500" textTransform="none" letterSpacing="normal">
            AI · {Math.round(confidence * 100)}%
          </Text>
        )}
      </FlowFormLabel>
      {isEditing ? (
        <HStack spacing={2}>
          <Box flex={1}>{children}</Box>
          <Box as="button" onClick={onConfirm} color="#1a7080" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}>
            <CheckIcon boxSize="14px" />
          </Box>
          <Box as="button" onClick={onCancel} color="gray.400" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}>
            <CloseIcon boxSize="13px" />
          </Box>
        </HStack>
      ) : hasSuggestion ? (
        <Text
          fontSize="13px"
          color="gray.700"
          cursor="pointer"
          px={2}
          py={1.5}
          borderRadius="8px"
          border="1px solid"
          borderColor="#9dd4d9"
          bg="#fafffe"
          _hover={{ borderColor: '#1a7080' }}
          onClick={onStartEdit}
        >
          {value}
        </Text>
      ) : (
        children
      )}
    </FormControl>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function CreateTaskModal({
  isOpen,
  onClose,
  onTaskCreated,
  defaultStatus = 'todo'
}: CreateTaskModalProps) {
  // Core fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [estimate, setEstimate] = useState('');
  const [complexity, setComplexity] = useState('');
  const [keyResultId, setKeyResultId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [epicId, setEpicId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  // Dropdown data
  const [keyResults, setKeyResults] = useState<KeyResult[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Enrichment
  const [definition, setDefinition] = useState<TaskDefinition | null>(null);
  const [isEnriching, setIsEnriching] = useState(false);
  const [enrichAttempted, setEnrichAttempted] = useState(false);
  const enrichTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline editing
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [suggestionsApplied, setSuggestionsApplied] = useState(false);

  // AI suggestions — gracefully handle missing IPC handler
  const [suggestions, setSuggestions] = useState<Suggestions>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const hasData = Object.keys(suggestions).length > 0;
  const noData = !suggestionsLoading && !hasData;

  // Track what AI suggested for calibration
  const [aiSuggestedValues, setAiSuggestedValues] = useState<Record<string, any>>({});

  const startEdit = (field: string, value: string) => { setEditingField(field); setEditBuffer(value); };
  const cancelEdit = () => { setEditingField(null); setEditBuffer(''); };

  const userName = (id: string) => {
    const u = users.find(u => u._id === id);
    return u ? (u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim()) : '';
  };
  const teamName = (id: string) => teams.find(t => t._id === id)?.name || '';
  const epicName = (id: string) => {
    const e = epics.find(e => e._id === id);
    return e ? (e.key ? `[${e.key}] ${e.title}` : e.title) : '';
  };
  const krName = (id: string) => keyResults.find(kr => kr._id === id)?.title || '';

  // ── Effects ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (isOpen) {
      setSuggestionsApplied(false);
      setAiSuggestedValues({});
    }
  }, [isOpen]);

  // Fetch AI suggestions when title is long enough (gracefully fail if IPC not ready)
  useEffect(() => {
    if (!isOpen || title.trim().length < 8) {
      setSuggestions({});
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSuggestionsLoading(true);
      try {
        const result = await (api as any).suggestTaskFields?.({ title: title.trim() });
        if (!cancelled && result) setSuggestions(result);
      } catch {
        // suggestTaskFields IPC not available yet — show form without suggestions
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isOpen, title]);

  // Apply AI suggestions when they arrive
  useEffect(() => {
    if (!hasData || suggestionsApplied) return;

    const applied: Record<string, any> = {};
    if (suggestions.priority?.value && !priority) { setPriority(suggestions.priority.value); applied.priority = suggestions.priority; }
    if (suggestions.assignee?.value && !assigneeId) { setAssigneeId(suggestions.assignee.value); applied.assignee = suggestions.assignee; }
    if (suggestions.complexity?.value && !complexity) { setComplexity(suggestions.complexity.value); applied.complexity = suggestions.complexity; }
    if (suggestions.dueDate?.value && !dueDate) { setDueDate(suggestions.dueDate.value); applied.dueDate = suggestions.dueDate; }
    if (suggestions.team?.value && !teamId) { setTeamId(suggestions.team.value); applied.team = suggestions.team; }
    if (suggestions.epic?.value && !epicId) { setEpicId(suggestions.epic.value); applied.epic = suggestions.epic; }
    if (suggestions.keyResult?.value && !keyResultId) { setKeyResultId(suggestions.keyResult.value); applied.keyResult = suggestions.keyResult; }

    setAiSuggestedValues(applied);
    setSuggestionsApplied(true);
  }, [hasData, suggestions, suggestionsApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced enrichment via IPC (gracefully fail)
  useEffect(() => {
    if (title.trim().length < 8) {
      setDefinition(null);
      if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
      return;
    }
    setIsEnriching(true);
    if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
    enrichTimerRef.current = setTimeout(async () => {
      try {
        const result = await (api as any).enrichTaskDefinition?.({ title: title.trim(), description: description.trim() });
        if (result) {
          setDefinition({ outcome: result.outcome || '', scope: result.scope || '', acceptanceCriteria: result.acceptanceCriteria || [], demoIdeas: result.demoIdeas || [] });
        } else {
          setDefinition(null);
        }
      } catch {
        setDefinition(null);
      } finally {
        setIsEnriching(false);
        setEnrichAttempted(true);
      }
    }, 1000);
    return () => { if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current); };
  }, [title, description]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = () => {
    setTitle(''); setDescription(''); setPriority(''); setDueDate('');
    setEstimate(''); setComplexity(''); setKeyResultId(''); setTeamId('');
    setEpicId(''); setAssigneeId(''); setDefinition(null); setEnrichAttempted(false);
    setEditingField(null); setSuggestionsApplied(false); setAiSuggestedValues({});
    setSuggestions({});
    if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
  };

  const handleClose = () => { resetForm(); onClose(); };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setIsLoading(true);
    try {
      await api.createTask({
        title: title.trim(),
        description: description.trim(),
        priority: priority || 'medium',
        status: defaultStatus,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
        estimate: estimate ? Number(estimate) : null,
        complexity: complexity || null,
        keyResultId: keyResultId || null,
        teamId: teamId || null,
        epicId: epicId || null,
        assigneeId: assigneeId || null,
        source: { type: 'manual' },
        definition: definition || null,
        aiSuggestions: aiSuggestedValues
      });
      handleClose();
      onTaskCreated();
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Enrichment panel ──────────────────────────────────────────────────

  const renderEnrichment = () => {
    if (title.trim().length < 8) return null;

    if (isEnriching) {
      return (
        <motion.div {...fieldAnim(2)}>
          <Box p={4} borderRadius="10px" border="1px solid" borderColor="#9dd4d9" bg="#f0fafa">
            <HStack spacing={2}>
              <Spinner size="xs" color="#1a7080" />
              <Text fontSize="12px" color="#1a7080">Analyzing task...</Text>
            </HStack>
          </Box>
        </motion.div>
      );
    }

    if (!definition && enrichAttempted) {
      return (
        <motion.div {...fieldAnim(2)}>
          <Box px={3} py={2} borderRadius="8px" border="1px solid" borderColor="gray.200" bg="gray.50">
            <Text fontSize="12px" color="gray.500">
              inWise is still learning about your projects. After a few meetings, task definitions will generate automatically.
            </Text>
          </Box>
        </motion.div>
      );
    }

    if (!definition) return null;

    return (
      <motion.div {...fieldAnim(2)}>
        <Box p={4} borderRadius="10px" border="1px solid" borderColor="#9dd4d9" bg="#f0fafa">
          <HStack justify="space-between" mb={3}>
            <HStack spacing={2}>
              <Box w="7px" h="7px" borderRadius="full" bg="#1a7080" />
              <Text fontSize="11px" fontWeight="700" color="#1a7080" textTransform="uppercase" letterSpacing="0.06em">AI Definition</Text>
            </HStack>
            <Text fontSize="10px" color="#1a7080">Click to edit</Text>
          </HStack>

          <VStack spacing={3} align="stretch">
            <Box>
              <Text fontSize="10px" fontWeight="700" color="#1a7080" textTransform="uppercase" letterSpacing="0.06em" mb="2px">Outcome</Text>
              {editingField === 'outcome' ? (
                <VStack align="stretch" spacing={1}>
                  <Textarea value={editBuffer} onChange={e => setEditBuffer(e.target.value)} autoFocus rows={2} {...TEXTAREA_PROPS} borderColor="#9dd4d9" />
                  <HStack spacing={2} justify="flex-end">
                    <Box as="button" onClick={() => { setDefinition({ ...definition, outcome: editBuffer }); cancelEdit(); }} color="#1a7080" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}><CheckIcon boxSize="14px" /></Box>
                    <Box as="button" onClick={cancelEdit} color="gray.400" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}><CloseIcon boxSize="13px" /></Box>
                  </HStack>
                </VStack>
              ) : (
                <Text fontSize="13px" lineHeight="20px" color="gray.700" cursor="pointer" _hover={{ bg: '#e8f4f5', borderRadius: '6px' }} px={1} mx={-1} onClick={() => startEdit('outcome', definition.outcome)}>
                  {definition.outcome || 'Click to add...'}
                </Text>
              )}
            </Box>

            <Box>
              <Text fontSize="10px" fontWeight="700" color="#1a7080" textTransform="uppercase" letterSpacing="0.06em" mb="2px">Scope</Text>
              {editingField === 'scope' ? (
                <VStack align="stretch" spacing={1}>
                  <Textarea value={editBuffer} onChange={e => setEditBuffer(e.target.value)} autoFocus rows={2} {...TEXTAREA_PROPS} borderColor="#9dd4d9" />
                  <HStack spacing={2} justify="flex-end">
                    <Box as="button" onClick={() => { setDefinition({ ...definition, scope: editBuffer }); cancelEdit(); }} color="#1a7080" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}><CheckIcon boxSize="14px" /></Box>
                    <Box as="button" onClick={cancelEdit} color="gray.400" cursor="pointer" lineHeight={0} _hover={{ opacity: 0.7 }}><CloseIcon boxSize="13px" /></Box>
                  </HStack>
                </VStack>
              ) : (
                <Text fontSize="13px" lineHeight="20px" color="gray.700" cursor="pointer" _hover={{ bg: '#e8f4f5', borderRadius: '6px' }} px={1} mx={-1} onClick={() => startEdit('scope', definition.scope)}>
                  {definition.scope || 'Click to add...'}
                </Text>
              )}
            </Box>

            {definition.acceptanceCriteria.length > 0 && (
              <Box>
                <Text fontSize="10px" fontWeight="700" color="#1a7080" textTransform="uppercase" letterSpacing="0.06em" mb="4px">Acceptance Criteria</Text>
                <VStack spacing={1} align="stretch">
                  {definition.acceptanceCriteria.map((c, i) => (
                    <HStack key={i} spacing={2}>
                      <Box w="5px" h="5px" borderRadius="full" bg="#9dd4d9" mt="7px" flexShrink={0} />
                      <Text fontSize="13px" lineHeight="20px" color="gray.700">{c}</Text>
                    </HStack>
                  ))}
                </VStack>
              </Box>
            )}
          </VStack>
        </Box>
      </motion.div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────

  const priorityLabels: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
  const complexityLabels: Record<string, string> = { XS: 'XS', S: 'S', M: 'M', L: 'L', XL: 'XL' };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" motionPreset="scale">
      <FlowModalOverlay />
      <FlowModalContent>
        <FlowModalHeader
          title="Create Task"
          subtitle={suggestionsLoading ? 'Loading AI suggestions...' : hasData ? 'AI-suggested fields below' : undefined}
        />
        <FlowModalBody>
          <AiSuggestionBanner isLoading={suggestionsLoading || isLoading} hasData={hasData} noData={noData} />
          <VStack spacing={4}>
            {/* Title — always an input */}
            <motion.div style={{ width: '100%' }} {...fieldAnim(0)}>
              <FormControl isRequired>
                <FlowFormLabel>Title</FlowFormLabel>
                <Input placeholder="What needs to be done?" value={title} onChange={e => setTitle(e.target.value)} autoFocus {...INPUT_PROPS} />
                {title.trim().length > 0 && title.trim().length < 8 && (
                  <FormHelperText fontSize="11px" color="gray.400">Type 8+ characters for AI suggestions</FormHelperText>
                )}
              </FormControl>
            </motion.div>

            {/* Description — always an input */}
            <motion.div style={{ width: '100%' }} {...fieldAnim(1)}>
              <FormControl>
                <FlowFormLabel>Description</FlowFormLabel>
                <Textarea placeholder="Add details..." value={description} onChange={e => setDescription(e.target.value)} rows={2} {...TEXTAREA_PROPS} />
              </FormControl>
            </motion.div>

            {/* AI enrichment panel */}
            {renderEnrichment()}

            {/* Priority — AI-suggested label or dropdown */}
            <motion.div style={{ width: '100%' }} {...fieldAnim(3)}>
              <SuggestedLabel
                label="Priority"
                value={priorityLabels[priority] || ''}
                confidence={suggestions.priority?.confidence}
                isEditing={editingField === 'priority'}
                onStartEdit={() => startEdit('priority', priority)}
                onConfirm={() => { setPriority(editBuffer); cancelEdit(); }}
                onCancel={cancelEdit}
              >
                <Select value={editingField === 'priority' ? editBuffer : priority} onChange={e => editingField === 'priority' ? setEditBuffer(e.target.value) : setPriority(e.target.value)} {...SELECT_PROPS}>
                  <option value="">Select...</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </Select>
              </SuggestedLabel>
            </motion.div>

            {/* Complexity + Estimate */}
            <motion.div style={{ width: '100%' }} {...fieldAnim(4)}>
              <SimpleGrid columns={2} spacing={4} w="100%">
                <SuggestedLabel
                  label="Complexity"
                  value={complexityLabels[complexity] || ''}
                  confidence={suggestions.complexity?.confidence}
                  isEditing={editingField === 'complexity'}
                  onStartEdit={() => startEdit('complexity', complexity)}
                  onConfirm={() => { setComplexity(editBuffer); cancelEdit(); }}
                  onCancel={cancelEdit}
                >
                  <Select placeholder="Select size" value={editingField === 'complexity' ? editBuffer : complexity} onChange={e => editingField === 'complexity' ? setEditBuffer(e.target.value) : setComplexity(e.target.value)} {...SELECT_PROPS}>
                    <option value="XS">XS</option>
                    <option value="S">S</option>
                    <option value="M">M</option>
                    <option value="L">L</option>
                    <option value="XL">XL</option>
                  </Select>
                </SuggestedLabel>

                <FormControl>
                  <FlowFormLabel>Estimate</FlowFormLabel>
                  <Select placeholder="Story points" value={estimate} onChange={e => setEstimate(e.target.value)} {...SELECT_PROPS}>
                    {[1, 2, 3, 5, 8, 13, 21].map(n => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </FormControl>
              </SimpleGrid>
            </motion.div>

            {/* Due Date */}
            <motion.div style={{ width: '100%' }} {...fieldAnim(5)}>
              <SuggestedLabel
                label="Due Date"
                value={dueDate || ''}
                confidence={suggestions.dueDate?.confidence}
                isEditing={editingField === 'dueDate'}
                onStartEdit={() => startEdit('dueDate', dueDate)}
                onConfirm={() => { setDueDate(editBuffer); cancelEdit(); }}
                onCancel={cancelEdit}
              >
                <Input type="date" value={editingField === 'dueDate' ? editBuffer : dueDate} onChange={e => editingField === 'dueDate' ? setEditBuffer(e.target.value) : setDueDate(e.target.value)} {...INPUT_PROPS} />
              </SuggestedLabel>
            </motion.div>

            {/* Epic */}
            <motion.div style={{ width: '100%' }} {...fieldAnim(6)}>
              <SuggestedLabel
                label="Epic"
                value={epicName(epicId) || ''}
                confidence={suggestions.epic?.confidence}
                isEditing={editingField === 'epic'}
                onStartEdit={() => startEdit('epic', epicId)}
                onConfirm={() => { setEpicId(editBuffer); cancelEdit(); }}
                onCancel={cancelEdit}
              >
                <Select placeholder="Select epic..." value={editingField === 'epic' ? editBuffer : epicId} onChange={e => editingField === 'epic' ? setEditBuffer(e.target.value) : setEpicId(e.target.value)} {...SELECT_PROPS}>
                  {epics.map(e => <option key={e._id} value={e._id}>{e.key ? `[${e.key}] ${e.title}` : e.title}</option>)}
                </Select>
              </SuggestedLabel>
            </motion.div>

            {/* Key Result */}
            <motion.div style={{ width: '100%' }} {...fieldAnim(7)}>
              <SuggestedLabel
                label="Key Result"
                value={krName(keyResultId) || ''}
                confidence={suggestions.keyResult?.confidence}
                isEditing={editingField === 'keyResult'}
                onStartEdit={() => startEdit('keyResult', keyResultId)}
                onConfirm={() => { setKeyResultId(editBuffer); cancelEdit(); }}
                onCancel={cancelEdit}
              >
                <Select placeholder="Select Key Result..." value={editingField === 'keyResult' ? editBuffer : keyResultId} onChange={e => editingField === 'keyResult' ? setEditBuffer(e.target.value) : setKeyResultId(e.target.value)} {...SELECT_PROPS}>
                  {keyResults.map(kr => <option key={kr._id} value={kr._id}>{kr.title} ({kr.progress}%)</option>)}
                </Select>
              </SuggestedLabel>
            </motion.div>
          </VStack>
        </FlowModalBody>
        <FlowModalFooter
          onCancel={handleClose}
          onConfirm={handleSubmit}
          confirmLabel="Create Task"
          isLoading={isLoading}
          isDisabled={!title.trim()}
        />
      </FlowModalContent>
    </Modal>
  );
}
