import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  Input,
  Textarea,
  FormControl,
  Select,
  VStack,
  HStack,
  Box,
  Text,
  Badge,
  Icon,
  Spinner,
  FormHelperText,
  SimpleGrid,
  Button
} from '@chakra-ui/react';
import { CheckIcon, CloseIcon } from '@chakra-ui/icons';
import { MdAutoAwesome } from 'react-icons/md';
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
  FLOW_SPRING,
  motion,
  AnimatePresence
} from '../modal/FlowModalShell';

interface Task {
  _id: string;
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  dueDate?: string;
  estimate?: number | null;
  complexity?: string | null;
  keyResultId?: string;
  status?: string;
  userId?: string;
  teamId?: string;
  blockerId?: string | null;
  source?: { type: string };
  actualHours?: number | null;
}

interface KeyResult {
  _id: string;
  title: string;
  progress: number;
  parentId: string;
  objective?: { title: string };
}

interface Suggestion { value?: string; confidence: number }
interface Suggestions { [key: string]: Suggestion }

interface EditTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTaskUpdated: () => void;
  task: any;
}

export default function EditTaskModal({ isOpen, onClose, onTaskUpdated, task }: EditTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [dueDate, setDueDate] = useState('');
  const [estimate, setEstimate] = useState('');
  const [complexity, setComplexity] = useState('');
  const [keyResultId, setKeyResultId] = useState('');
  const [keyResults, setKeyResults] = useState<KeyResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingKRs, setIsLoadingKRs] = useState(false);
  const [timeEstimate, setTimeEstimate] = useState<{
    label: string; confidence: string; source: string;
    modifiersApplied: string[]; sampleSize: number;
  } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [suggestionsApplied, setSuggestionsApplied] = useState(false);

  // SuggestedLabel inline editing state
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [_aiSuggestedValues, setAiSuggestedValues] = useState<Record<string, string>>({});
  const editRef = useRef<HTMLSelectElement | HTMLInputElement | null>(null);

  // AI suggestions — gracefully handle missing IPC handler
  const [suggestions, setSuggestions] = useState<Suggestions>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const hasData = Object.keys(suggestions).length > 0;
  const noData = !suggestionsLoading && !hasData;

  const getSuggestion = (key: string): Suggestion | undefined => suggestions[key];

  // Reset suggestionsApplied when modal opens
  useEffect(() => {
    if (isOpen) {
      setSuggestionsApplied(false);
      setEditingField(null);
      setAiSuggestedValues({});
      setSuggestions({});
    }
  }, [isOpen]);

  // Fetch AI suggestions when modal opens with a task (gracefully fail)
  useEffect(() => {
    if (!isOpen || !task) return;
    let cancelled = false;
    (async () => {
      setSuggestionsLoading(true);
      try {
        const result = await (api as any).suggestTaskFields?.({ task });
        if (!cancelled && result) setSuggestions(result);
      } catch {
        // suggestTaskFields IPC not available yet — show form without suggestions
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, task]);

  // Mark suggestions as applied once they arrive (don't auto-apply priority)
  useEffect(() => {
    if (suggestionsApplied) return;
    if (suggestions.priority?.value || suggestions.priorityReason?.value) {
      if (suggestions.priority?.value) {
        setAiSuggestedValues(prev => ({ ...prev, priority: suggestions.priority.value! }));
      }
      setSuggestionsApplied(true);
    }
  }, [suggestions, suggestionsApplied]);

  // Focus editing field
  useEffect(() => {
    if (editingField && editRef.current) editRef.current.focus();
  }, [editingField]);

  const buildEstimateRationale = (
    est: { source: string; sampleSize: number; modifiersApplied: string[] }
  ): string => {
    const mods = est.modifiersApplied || [];
    const factors: string[] = [];
    if (mods.some(m => m.includes('blocker'))) factors.push('a dependency blocker');
    if (mods.some(m => m.includes('critical'))) factors.push('critical priority');
    else if (mods.some(m => m.includes('high priority'))) factors.push('high priority');
    if (mods.some(m => m.includes('no assignee'))) factors.push('no assignee yet');
    if (mods.some(m => m.includes('manual'))) factors.push('manually created');
    const factorStr = factors.length > 0 ? `, adjusted for ${factors.join(' and ')}` : '';
    if (est.source === 'phase2_velocity') return `Based on your personal history with ${complexity}-sized tasks (${est.sampleSize} completed)${factorStr}.`;
    if (est.source === 'phase3_similar') return `Derived from ${est.sampleSize} similar tasks across your team${factorStr}.`;
    if (factors.length > 0) return `Estimated from the ${complexity} complexity baseline, adjusted for ${factors.join(' and ')}.`;
    return `Estimated from the ${complexity} complexity baseline.`;
  };

  useEffect(() => {
    if (isOpen && task) {
      setTitle(task.title || '');
      setDescription(task.description || '');
      setPriority(task.priority || 'medium');
      setDueDate(task.dueDate ? task.dueDate.split('T')[0] : '');
      setEstimate(task.estimate ? String(task.estimate) : '');
      setComplexity(task.complexity || '');
      setKeyResultId(task.keyResultId || '');
      setTimeEstimate(null);
    }
  }, [isOpen, task]);

  const fetchTimeEstimate = async () => {
    if (!complexity) return;
    if (timeEstimate) { setTimeEstimate(null); return; }
    setEstimating(true);
    try {
      const res = await (api as any).estimateTask?.({
        complexity,
        priority,
        sourceType: task?.source?.type,
        assigneeId: task?.userId,
        teamId: task?.teamId,
        hasBlocker: !!task?.blockerId,
      });
      if (res) setTimeEstimate(res);
    } catch { /* silently fail */ }
    finally { setEstimating(false); }
  };

  const resetForm = () => {
    setTitle(''); setDescription(''); setPriority('medium');
    setDueDate(''); setEstimate(''); setComplexity('');
    setKeyResultId(''); setTimeEstimate(null);
  };

  const handleClose = () => { resetForm(); onClose(); };

  const handleSubmit = async () => {
    if (!title.trim() || !task) return;

    setIsLoading(true);
    try {
      await api.updateTask(task._id, {
        title: title.trim(),
        description: description.trim(),
        priority,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
        estimate: estimate ? Number(estimate) : null,
        complexity: complexity || null,
        keyResultId: keyResultId || null
      });
      handleClose();
      onTaskUpdated();
    } catch (err) {
      console.error('Failed to update task:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // ── SuggestedLabel helpers ──
  const startEditing = (field: string, currentVal: string) => {
    setEditingField(field);
    setEditBuffer(currentVal);
  };

  const confirmEdit = (field: string) => {
    switch (field) {
      case 'complexity': setComplexity(editBuffer); break;
      case 'estimate': setEstimate(editBuffer); break;
      case 'keyResultId': setKeyResultId(editBuffer); break;
    }
    setEditingField(null);
    setEditBuffer('');
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditBuffer('');
  };

  const complexityLabels: Record<string, string> = { XS: 'XS', S: 'S', M: 'M', L: 'L', XL: 'XL' };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" motionPreset="scale">
      <FlowModalOverlay />
      <FlowModalContent>
        <FlowModalHeader title="Edit Task" />
        <FlowModalBody>
          <AiSuggestionBanner isLoading={suggestionsLoading || isLoading} hasData={hasData} noData={noData} />
          <VStack spacing={4}>
            <motion.div style={{ width: '100%' }} {...fieldAnim(0)}>
              <FormControl isRequired>
                <FlowFormLabel>Title</FlowFormLabel>
                <Input
                  placeholder="What needs to be done?"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                  {...INPUT_PROPS}
                />
              </FormControl>
            </motion.div>

            <motion.div style={{ width: '100%' }} {...fieldAnim(1)}>
              <FormControl>
                <FlowFormLabel>Description</FlowFormLabel>
                <Textarea
                  placeholder="Add details..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  {...TEXTAREA_PROPS}
                />
              </FormControl>
            </motion.div>

            <motion.div style={{ width: '100%' }} {...fieldAnim(2)}>
              <FormControl>
                <FlowFormLabel>Priority</FlowFormLabel>
                <Select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} {...SELECT_PROPS}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </Select>
                {getSuggestion('priority')?.value && getSuggestion('priority')!.value !== priority && (
                  <Text fontSize="11px" color="teal.500" mt={1}>
                    AI suggests: {getSuggestion('priority')!.value!.charAt(0).toUpperCase() + getSuggestion('priority')!.value!.slice(1)} · {Math.round(getSuggestion('priority')!.confidence * 100)}%
                  </Text>
                )}
                {getSuggestion('priorityReason')?.value && (
                  <FormHelperText fontSize="11px" color="gray.500" mt={1}>{getSuggestion('priorityReason')!.value}</FormHelperText>
                )}
              </FormControl>
            </motion.div>

            <motion.div style={{ width: '100%' }} {...fieldAnim(3)}>
              <SimpleGrid columns={2} spacing={4} w="100%">
                {/* Complexity — SuggestedLabel */}
                <FormControl>
                  <FlowFormLabel>
                    Complexity
                    {getSuggestion('complexity')?.value && complexity === getSuggestion('complexity')!.value && (
                      <Text as="span" fontSize="9px" color="#1a7080" ml={2} fontWeight="500" textTransform="none" letterSpacing="normal">
                        AI · {Math.round(getSuggestion('complexity')!.confidence * 100)}%
                      </Text>
                    )}
                  </FlowFormLabel>
                  {editingField === 'complexity' ? (
                    <HStack spacing={1}>
                      <Select
                        ref={editRef as any}
                        placeholder="Select size"
                        value={editBuffer}
                        onChange={(e) => setEditBuffer(e.target.value)}
                        size="sm"
                        {...SELECT_PROPS}
                      >
                        <option value="XS">XS</option>
                        <option value="S">S</option>
                        <option value="M">M</option>
                        <option value="L">L</option>
                        <option value="XL">XL</option>
                      </Select>
                      <CheckIcon
                        color="#1a7080"
                        boxSize="14px"
                        cursor="pointer"
                        onClick={() => confirmEdit('complexity')}
                      />
                      <CloseIcon
                        color="gray.400"
                        boxSize="13px"
                        cursor="pointer"
                        onClick={cancelEdit}
                      />
                    </HStack>
                  ) : complexity ? (
                    <Box
                      px={3} py={2} borderRadius="8px" cursor="pointer"
                      border="1px solid"
                      borderColor={getSuggestion('complexity')?.value && complexity === getSuggestion('complexity')!.value ? '#9dd4d9' : 'gray.200'}
                      bg={getSuggestion('complexity')?.value && complexity === getSuggestion('complexity')!.value ? '#f0fafa' : 'white'}
                      onClick={() => startEditing('complexity', complexity)}
                    >
                      <Text fontSize="sm">{complexityLabels[complexity] || complexity}</Text>
                    </Box>
                  ) : (
                    <Select placeholder="Select size" value={complexity} onChange={(e) => setComplexity(e.target.value)} {...SELECT_PROPS}>
                      <option value="XS">XS</option>
                      <option value="S">S</option>
                      <option value="M">M</option>
                      <option value="L">L</option>
                      <option value="XL">XL</option>
                    </Select>
                  )}
                </FormControl>

                {/* Estimate — SuggestedLabel */}
                <FormControl>
                  <FlowFormLabel>
                    Estimate
                    {getSuggestion('estimate')?.value && estimate === getSuggestion('estimate')!.value && (
                      <Text as="span" fontSize="9px" color="#1a7080" ml={2} fontWeight="500" textTransform="none" letterSpacing="normal">
                        AI · {Math.round(getSuggestion('estimate')!.confidence * 100)}%
                      </Text>
                    )}
                  </FlowFormLabel>
                  {editingField === 'estimate' ? (
                    <HStack spacing={1}>
                      <Select
                        ref={editRef as any}
                        placeholder="Story points"
                        value={editBuffer}
                        onChange={(e) => setEditBuffer(e.target.value)}
                        size="sm"
                        {...SELECT_PROPS}
                      >
                        {[1, 2, 3, 5, 8, 13, 21].map(n => <option key={n} value={n}>{n}</option>)}
                      </Select>
                      <CheckIcon
                        color="#1a7080"
                        boxSize="14px"
                        cursor="pointer"
                        onClick={() => confirmEdit('estimate')}
                      />
                      <CloseIcon
                        color="gray.400"
                        boxSize="13px"
                        cursor="pointer"
                        onClick={cancelEdit}
                      />
                    </HStack>
                  ) : estimate ? (
                    <Box
                      px={3} py={2} borderRadius="8px" cursor="pointer"
                      border="1px solid"
                      borderColor={getSuggestion('estimate')?.value && estimate === getSuggestion('estimate')!.value ? '#9dd4d9' : 'gray.200'}
                      bg={getSuggestion('estimate')?.value && estimate === getSuggestion('estimate')!.value ? '#f0fafa' : 'white'}
                      onClick={() => startEditing('estimate', estimate)}
                    >
                      <Text fontSize="sm">{estimate} pts</Text>
                    </Box>
                  ) : (
                    <Select placeholder="Story points" value={estimate} onChange={(e) => setEstimate(e.target.value)} {...SELECT_PROPS}>
                      {[1, 2, 3, 5, 8, 13, 21].map(n => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  )}
                </FormControl>
              </SimpleGrid>
            </motion.div>

            {/* AI time estimate — animates in when complexity is selected */}
            <AnimatePresence initial={false}>
              {complexity && (
                <motion.div
                  style={{ width: '100%' }}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={FLOW_SPRING}
                >
                  <Box w="100%">
                    <Button
                      size="sm"
                      variant="ghost"
                      color="#1a7080"
                      leftIcon={estimating ? <Spinner size="xs" color="#1a7080" /> : <Icon as={MdAutoAwesome} boxSize={3.5} />}
                      onClick={fetchTimeEstimate}
                      px={2}
                      _hover={{ bg: '#e8f4f5' }}
                      fontWeight="medium"
                      isDisabled={estimating}
                    >
                      {timeEstimate ? timeEstimate.label : 'Estimate time'}
                    </Button>

                    <AnimatePresence initial={false}>
                      {timeEstimate && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.97, y: -6 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.97, y: -6 }}
                          transition={FLOW_SPRING}
                        >
                          <Box mt={2} bg="#e8f4f5" borderRadius="10px" px={3} py={2.5} border="1px solid" borderColor="#9dd4d9">
                            <HStack spacing={2} mb={1.5}>
                              <Icon as={MdAutoAwesome} color="#1a7080" boxSize={3.5} />
                              <Text fontSize="md" fontWeight="bold" color="#1a7080">{timeEstimate.label}</Text>
                              <Badge bg="#1a7080" color="white" fontSize="xs" borderRadius="full" px={2}>
                                {timeEstimate.confidence === 'high' ? 'High confidence' : timeEstimate.confidence === 'medium' ? 'Medium confidence' : 'AI estimate'}
                              </Badge>
                            </HStack>
                            <Text fontSize="xs" color="#1a7080">{buildEstimateRationale(timeEstimate)}</Text>
                          </Box>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </Box>
                </motion.div>
              )}
            </AnimatePresence>

            <motion.div style={{ width: '100%' }} {...fieldAnim(4)}>
              <FormControl>
                <FlowFormLabel>Due Date</FlowFormLabel>
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} {...INPUT_PROPS} />
              </FormControl>
            </motion.div>

            <motion.div style={{ width: '100%' }} {...fieldAnim(5)}>
              {/* Link to Key Result — SuggestedLabel */}
              <FormControl>
                <FlowFormLabel>
                  Link to Key Result
                  {getSuggestion('keyResultId')?.value && keyResultId === getSuggestion('keyResultId')!.value && (
                    <Text as="span" fontSize="9px" color="#1a7080" ml={2} fontWeight="500" textTransform="none" letterSpacing="normal">
                      AI · {Math.round(getSuggestion('keyResultId')!.confidence * 100)}%
                    </Text>
                  )}
                </FlowFormLabel>
                {editingField === 'keyResultId' ? (
                  <HStack spacing={1}>
                    <Select
                      ref={editRef as any}
                      placeholder={isLoadingKRs ? 'Loading...' : 'Select a Key Result'}
                      value={editBuffer}
                      onChange={(e) => setEditBuffer(e.target.value)}
                      isDisabled={isLoadingKRs}
                      size="sm"
                      {...SELECT_PROPS}
                    >
                      {keyResults.map((kr) => (
                        <option key={kr._id} value={kr._id}>{kr.title} ({kr.progress}%)</option>
                      ))}
                    </Select>
                    <CheckIcon
                      color="#1a7080"
                      boxSize="14px"
                      cursor="pointer"
                      onClick={() => confirmEdit('keyResultId')}
                    />
                    <CloseIcon
                      color="gray.400"
                      boxSize="13px"
                      cursor="pointer"
                      onClick={cancelEdit}
                    />
                  </HStack>
                ) : keyResultId ? (
                  <Box
                    px={3} py={2} borderRadius="8px" cursor="pointer"
                    border="1px solid"
                    borderColor={getSuggestion('keyResultId')?.value && keyResultId === getSuggestion('keyResultId')!.value ? '#9dd4d9' : 'gray.200'}
                    bg={getSuggestion('keyResultId')?.value && keyResultId === getSuggestion('keyResultId')!.value ? '#f0fafa' : 'white'}
                    onClick={() => startEditing('keyResultId', keyResultId)}
                  >
                    <Text fontSize="sm">
                      {keyResults.find(kr => kr._id === keyResultId)?.title || keyResultId}
                    </Text>
                  </Box>
                ) : (
                  <Select
                    placeholder={isLoadingKRs ? 'Loading...' : 'Select a Key Result (optional)'}
                    value={keyResultId}
                    onChange={(e) => setKeyResultId(e.target.value)}
                    isDisabled={isLoadingKRs}
                    {...SELECT_PROPS}
                  >
                    {keyResults.map((kr) => (
                      <option key={kr._id} value={kr._id}>{kr.title} ({kr.progress}%)</option>
                    ))}
                  </Select>
                )}
                <FormHelperText fontSize="11px" color="gray.400">Link this task to an OKR key result to track progress</FormHelperText>
              </FormControl>
            </motion.div>
          </VStack>
        </FlowModalBody>
        <FlowModalFooter
          onCancel={handleClose}
          onConfirm={handleSubmit}
          confirmLabel="Save Changes"
          isLoading={isLoading}
        />
      </FlowModalContent>
    </Modal>
  );
}
