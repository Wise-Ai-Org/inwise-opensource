import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  Flex,
  Text,
  SimpleGrid,
  Badge,
  VStack,
  HStack,
  IconButton,
  useColorModeValue,
  useDisclosure,
  useToast,
  Spinner,
  Button,
  Tooltip,
  Icon,
  Collapse,
  Alert,
  AlertIcon,
  AlertTitle,
  AlertDescription,
  CloseButton,
  AlertDialog,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogOverlay,
  Modal
} from '@chakra-ui/react';
import { AddIcon, RepeatIcon, CheckIcon, CloseIcon, StarIcon, InfoOutlineIcon, DeleteIcon, DragHandleIcon } from '@chakra-ui/icons';
import { MdAutoAwesome, MdVideoCall, MdEmail, MdChat, MdLink, MdArchive } from 'react-icons/md';
import Card from './components/card/Card';
import CreateTaskModal from './components/tasks/CreateTaskModal';
import EditTaskModal from './components/tasks/EditTaskModal';
import TaskDetailSidebar from './components/tasks/TaskDetailSidebar';
import { api } from './api';
import {
  FlowModalOverlay,
  FlowModalContent,
  FlowModalHeader,
  FlowModalBody,
  FlowModalFooter
} from './components/modal/FlowModalShell';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/* ─── Priority Review types & components ──────────────────────────────────── */

interface PriorityChange {
  _id: string;
  taskId: string;
  title: string;
  priority: string;
  suggestedPriority: string;
  score: number;
  reasoning: string;
}

function scoreColor(score: number): string {
  if (score >= 70) return 'red';
  if (score >= 40) return 'orange';
  return 'gray';
}

function SortablePriorityRow({ item, index }: { item: PriorityChange; index: number }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: item._id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 'auto' as any
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      p={3}
      mb={2}
      bg="white"
      borderRadius="8px"
      borderWidth="1px"
      borderColor={isDragging ? 'teal.300' : 'gray.200'}
      boxShadow={isDragging ? 'lg' : 'sm'}
      _hover={{ borderColor: 'gray.300' }}
    >
      <HStack spacing={3}>
        <Box
          {...attributes}
          {...listeners}
          cursor="grab"
          color="gray.400"
          _hover={{ color: 'gray.600' }}
          flexShrink={0}
        >
          <DragHandleIcon />
        </Box>

        <Box flex="1" minW={0}>
          <Text fontSize="sm" fontWeight="600" noOfLines={1}>
            {item.title}
          </Text>
          <HStack spacing={2} mt={1}>
            <Text
              fontSize="xs"
              color="gray.400"
              textDecoration="line-through"
              textTransform="capitalize"
            >
              {item.priority}
            </Text>
            <Text fontSize="xs" color="gray.400">&rarr;</Text>
            <Text
              fontSize="xs"
              fontWeight="700"
              color={`${scoreColor(item.score) === 'red' ? 'red' : scoreColor(item.score) === 'orange' ? 'orange' : 'gray'}.600`}
              textTransform="capitalize"
            >
              {item.suggestedPriority}
            </Text>
          </HStack>
          {item.reasoning && (
            <Text fontSize="xs" color="gray.500" mt={1} noOfLines={2}>
              {item.reasoning}
            </Text>
          )}
        </Box>

        <Badge
          colorScheme={scoreColor(item.score)}
          fontSize="xs"
          borderRadius="full"
          px={2}
          flexShrink={0}
        >
          {item.score}
        </Badge>
      </HStack>
    </Box>
  );
}

function PriorityReviewModal({
  isOpen,
  onClose,
  onApplyChanges
}: {
  isOpen: boolean;
  onClose: () => void;
  onApplyChanges: (changes: PriorityChange[]) => Promise<void>;
}) {
  const [changes, setChanges] = useState<PriorityChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  // Fetch scored tasks when modal opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const fetchScores = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getScoredTasks();
        if (!cancelled) {
          setChanges(data?.priorityChanges || data || []);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to score tasks');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchScores();
    return () => { cancelled = true; };
  }, [isOpen]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setChanges(prev => {
      const oldIndex = prev.findIndex(c => c._id === active.id);
      const newIndex = prev.findIndex(c => c._id === over.id);
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      await onApplyChanges(changes);
      onClose();
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} motionPreset="scale" size="xl">
      <FlowModalOverlay />
      <FlowModalContent>
        <FlowModalHeader
          title="Review Priorities"
          subtitle={changes.length > 0 ? `${changes.length} suggested changes` : undefined}
          status="ai"
          statusLabel="AI Scored"
        />
        <FlowModalBody maxH="calc(70vh - 130px)">
          {loading && (
            <Flex justify="center" align="center" py={12}>
              <VStack spacing={3}>
                <Spinner size="lg" color="#1a7080" />
                <Text fontSize="sm" color="gray.500">Scoring tasks...</Text>
              </VStack>
            </Flex>
          )}

          {error && (
            <Box p={4} bg="red.50" borderRadius="8px" borderWidth="1px" borderColor="red.200">
              <Text fontSize="sm" color="red.600">{error}</Text>
            </Box>
          )}

          {!loading && !error && changes.length === 0 && (
            <Box p={6} textAlign="center">
              <Text fontSize="sm" color="gray.500">
                All tasks are already at their suggested priority. Nothing to change.
              </Text>
            </Box>
          )}

          {!loading && !error && changes.length > 0 && (() => {
            // Build zone segments from actual task scores (sorted top=highest)
            const zones: { label: string; color: string; bg: string; borderColor: string; count: number }[] = [];
            let currentZone = '';
            for (const item of changes) {
              const zone = item.score >= 50 ? 'High' : item.score >= 25 ? 'Medium' : 'Low';
              if (zone !== currentZone) {
                const zoneStyle = zone === 'High'
                  ? { color: 'red.500', bg: 'red.50', borderColor: 'red.200' }
                  : zone === 'Medium'
                  ? { color: 'orange.500', bg: 'orange.50', borderColor: 'orange.200' }
                  : { color: 'gray.400', bg: 'gray.50', borderColor: 'gray.200' };
                zones.push({ label: zone, ...zoneStyle, count: 1 });
                currentZone = zone;
              } else {
                zones[zones.length - 1].count++;
              }
            }
            const totalItems = changes.length;

            return (
              <HStack spacing={3} align="stretch">
                {/* Vertical priority zone bar — sized proportionally to actual items per zone */}
                <Box w="36px" flexShrink={0} borderRadius="8px" overflow="hidden" border="1px solid" borderColor="gray.200" display="flex" flexDirection="column">
                  {zones.map((zone, i) => (
                    <Box
                      key={`${zone.label}-${i}`}
                      flex={zone.count}
                      bg={zone.bg}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      borderBottom={i < zones.length - 1 ? '1px solid' : 'none'}
                      borderColor={zone.borderColor}
                      minH={`${Math.max(24, (zone.count / totalItems) * 100)}px`}
                    >
                      <Text
                        fontSize="9px"
                        fontWeight="800"
                        color={zone.color}
                        textTransform="uppercase"
                        sx={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                      >
                        {zone.label}
                      </Text>
                    </Box>
                  ))}
                </Box>

                {/* Sortable task list */}
                <Box flex={1}>
                  <DndContext
                    sensors={sortSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={changes.map(c => c._id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {changes.map((item, i) => (
                        <SortablePriorityRow key={item._id} item={item} index={i} />
                      ))}
                    </SortableContext>
                  </DndContext>
                </Box>
              </HStack>
            );
          })()}
        </FlowModalBody>
        <FlowModalFooter
          onCancel={onClose}
          onConfirm={changes.length > 0 ? handleApply : undefined}
          confirmLabel="Apply Changes"
          isLoading={applying}
          isDisabled={loading || changes.length === 0}
        />
      </FlowModalContent>
    </Modal>
  );
}

interface TaskApproval {
  status: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  notes?: string | null;
}

interface AIPriority {
  score: number;
  reasoning: string;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  rankedAt: string;
}

interface TaskProvenance {
  meetingId?: string | null;
  transcriptId?: string | null;
  emailId?: string | null;
  slackThreadId?: string | null;
  extractionMethod: string;
  extractedAt: string;
}

interface Task {
  _id: string;
  title: string;
  description: string;
  status: 'todo' | 'inProgress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'critical';
  dueDate: string | null;
  source: {
    type: string;
    id?: string;
    url?: string;
  };
  aiExtracted: boolean;
  aiConfidence?: number;
  approval?: TaskApproval;
  provenance?: TaskProvenance;
  distillationSessionId?: string;
  keyResultId: string | null;
  keyResult?: {
    title: string;
    progress: number;
  };
  aiPriority?: AIPriority;
  priorityScore?: number;
  priorityReasoning?: string;
  estimate?: number | null;
  complexity?: string | null;
  userId?: string;
  teamId?: string;
  blockerId?: string | null;
  actualHours?: number | null;
  likelyDone?: boolean;
}

const priorityColors: Record<string, string> = {
  low: 'gray',
  medium: 'blue',
  high: 'orange',
  critical: 'red'
};

const sourceLabels: Record<string, string> = {
  manual: 'Manual',
  meeting: 'Meeting',
  jira: 'JIRA',
  email: 'Email',
  slack: 'Slack'
};

function TaskCard({
  task,
  onStatusChange,
  onApprove,
  onReject,
  onClick,
  onArchive,
  onDelete,
  onConfirmLikelyDone,
  onRejectLikelyDone,
  isOverlay = false
}: {
  task: Task;
  onStatusChange: (taskId: string, status: string) => void;
  onApprove?: (taskId: string) => void;
  onReject?: (taskId: string) => void;
  onClick?: (task: Task) => void;
  onArchive?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onConfirmLikelyDone?: (taskId: string) => void;
  onRejectLikelyDone?: (taskId: string) => void;
  isOverlay?: boolean;
}) {
  const cardBg = useColorModeValue('white', 'gray.700');
  const borderColor = useColorModeValue('gray.200', 'gray.600');
  const pendingBorderColor = useColorModeValue('yellow.300', 'yellow.500');
  const [hovered, setHovered] = useState(false);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task._id,
    disabled: isOverlay
  });
  const dragStyle = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.35 : 1
  };

  const isPendingApproval = task.aiExtracted && task.approval?.status === 'pending';

  return (
    <Card
      ref={setNodeRef}
      style={dragStyle}
      {...(!isOverlay ? attributes : {})}
      {...(!isOverlay ? listeners : {})}
      p={4}
      mb={3}
      bg={cardBg}
      borderWidth={isPendingApproval ? '2px' : '1px'}
      borderColor={isPendingApproval ? pendingBorderColor : borderColor}
      borderRadius="lg"
      boxShadow={isOverlay || isDragging ? 'xl' : 'sm'}
      _hover={{ boxShadow: isDragging ? 'xl' : 'md' }}
      cursor={isOverlay || isDragging ? 'grabbing' : 'grab'}
      userSelect="none"
      onClick={() => !isDragging && !isOverlay && onClick?.(task)}
      onMouseEnter={() => !isOverlay && setHovered(true)}
      onMouseLeave={() => !isOverlay && setHovered(false)}
      position="relative"
      transform={isOverlay ? 'rotate(2deg)' : undefined}
    >
      <VStack align="stretch" spacing={2}>
        <HStack justify="space-between">
          <HStack spacing={1}>
            <Badge colorScheme={priorityColors[task.priority]} fontSize="xs">
              {task.priority}
            </Badge>
            {task.priorityScore != null && (
              <Badge colorScheme={task.priorityScore >= 70 ? 'red' : task.priorityScore >= 40 ? 'orange' : 'gray'}
                fontSize="xs" title={task.priorityReasoning || ''}>
                {task.priorityScore}
              </Badge>
            )}
            {task.estimate && (
              <Badge colorScheme="teal" fontSize="xs">
                {task.estimate} pts
              </Badge>
            )}
            {task.complexity && (
              <Badge colorScheme="gray" fontSize="xs">
                {task.complexity}
              </Badge>
            )}
            {task.keyResultId && (
              <Badge colorScheme="green" fontSize="xs" title={task.keyResult?.title || 'Linked to KR'}>
                KR
              </Badge>
            )}
          </HStack>
          <HStack spacing={1}>
            {task.aiExtracted && (
              <Badge
                colorScheme={isPendingApproval ? 'yellow' : 'purple'}
                fontSize="xs"
                title={task.aiConfidence ? `${Math.round(task.aiConfidence * 100)}% confidence` : 'AI extracted'}
              >
                {isPendingApproval ? 'Pending' : 'AI'}
              </Badge>
            )}
            {task.approval?.status === 'auto_approved' && (
              <Badge colorScheme="cyan" fontSize="xs">Auto</Badge>
            )}
            <HStack
              spacing={0}
              opacity={hovered ? 1 : 0}
              transition="opacity 0.15s"
            >
              <Tooltip label="Archive" placement="top">
                <IconButton
                  aria-label="Archive task"
                  icon={<Icon as={MdArchive} />}
                  size="xs"
                  variant="ghost"
                  colorScheme="gray"
                  onClick={(e) => { e.stopPropagation(); onArchive?.(task._id); }}
                />
              </Tooltip>
              <Tooltip label="Delete permanently" placement="top">
                <IconButton
                  aria-label="Delete task"
                  icon={<DeleteIcon />}
                  size="xs"
                  variant="ghost"
                  colorScheme="red"
                  onClick={(e) => { e.stopPropagation(); onDelete?.(task._id); }}
                />
              </Tooltip>
            </HStack>
          </HStack>
        </HStack>

        <Text fontWeight="semibold" fontSize="sm" noOfLines={2}>
          {task.title}
        </Text>

        {task.likelyDone && (
          <HStack
            spacing={2}
            p={2}
            bg="green.50"
            borderRadius="md"
            borderLeftWidth="3px"
            borderLeftColor="green.400"
            data-testid="likely-done-pill"
          >
            <Badge colorScheme="green" fontSize="xs">Done?</Badge>
            <Text fontSize="xs" color="gray.700" flex={1}>
              Transcript suggests this is completed.
            </Text>
            <Button
              size="xs"
              colorScheme="green"
              onClick={(e) => { e.stopPropagation(); onConfirmLikelyDone?.(task._id); }}
            >
              Yes
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onRejectLikelyDone?.(task._id); }}
            >
              No
            </Button>
          </HStack>
        )}

        {task.priorityReasoning && task.priorityReasoning !== 'Standard priority' && (
          <Text fontSize="xs" color="orange.500" noOfLines={1}>{task.priorityReasoning}</Text>
        )}

        {task.description && (
          <Text fontSize="xs" color="gray.500" noOfLines={2}>
            {task.description}
          </Text>
        )}

        <HStack justify="space-between" mt={2}>
          {task.source?.type === 'jira' ? (
            <Badge colorScheme="blue" variant="subtle" fontSize="xs" cursor="pointer"
              onClick={e => { e.stopPropagation(); if (task.source?.url) api.openExternal(task.source.url); }}>
              {task.source?.id || 'JIRA'}
            </Badge>
          ) : (
            <Badge variant="outline" fontSize="xs">
              {sourceLabels[task.source?.type] || task.source?.type}
            </Badge>
          )}
          {task.dueDate && (
            <Text fontSize="xs" color="gray.500">
              {new Date(task.dueDate).toLocaleDateString()}
            </Text>
          )}
        </HStack>

        {task.keyResult && (
          <Text fontSize="xs" color="green.600" noOfLines={1}>
            KR: {task.keyResult.title}
          </Text>
        )}

        {/* Provenance - Source Trail for AI-extracted tasks */}
        {task.provenance && (
          <Box
            mt={2}
            p={2}
            bg="purple.50"
            borderRadius="md"
            borderLeftWidth="3px"
            borderLeftColor="purple.400"
          >
            <HStack spacing={2} mb={1}>
              <Icon as={MdLink} color="purple.500" boxSize={3} />
              <Text fontSize="xs" fontWeight="bold" color="purple.700">
                Source Trail
              </Text>
            </HStack>
            <HStack spacing={2} flexWrap="wrap">
              {task.provenance.meetingId && (
                <Badge colorScheme="brand" fontSize="xs" variant="subtle">
                  <HStack spacing={1}>
                    <Icon as={MdVideoCall} boxSize={3} />
                    <Text>Meeting</Text>
                  </HStack>
                </Badge>
              )}
              {task.provenance.emailId && (
                <Badge colorScheme="orange" fontSize="xs" variant="subtle">
                  <HStack spacing={1}>
                    <Icon as={MdEmail} boxSize={3} />
                    <Text>Email</Text>
                  </HStack>
                </Badge>
              )}
              {task.provenance.slackThreadId && (
                <Badge colorScheme="brand" fontSize="xs" variant="subtle">
                  <HStack spacing={1}>
                    <Icon as={MdChat} boxSize={3} />
                    <Text>Slack</Text>
                  </HStack>
                </Badge>
              )}
            </HStack>
            <Text fontSize="xs" color="gray.500" mt={1}>
              Extracted {new Date(task.provenance.extractedAt).toLocaleDateString()} via {task.provenance.extractionMethod}
            </Text>
          </Box>
        )}

        {/* AI Priority Badge */}
        {task.aiPriority && (
          <Box
            mt={2}
            p={2}
            bg={task.aiPriority.urgency === 'critical' ? 'red.50' : task.aiPriority.urgency === 'high' ? 'orange.50' : 'blue.50'}
            borderRadius="md"
            borderLeftWidth="3px"
            borderLeftColor={`${priorityColors[task.aiPriority.urgency]}.500`}
          >
            <HStack justify="space-between" mb={1}>
              <HStack spacing={1}>
                <Icon as={MdAutoAwesome} color={`${priorityColors[task.aiPriority.urgency]}.500`} boxSize={3} />
                <Text fontSize="xs" fontWeight="bold" color={`${priorityColors[task.aiPriority.urgency]}.700`}>
                  AI Priority: {task.aiPriority.score}/100
                </Text>
              </HStack>
              <Badge colorScheme={priorityColors[task.aiPriority.urgency]} fontSize="xs">
                {task.aiPriority.urgency}
              </Badge>
            </HStack>
            <Text fontSize="xs" color="gray.600" noOfLines={2}>
              {task.aiPriority.reasoning}
            </Text>
          </Box>
        )}

        {/* Quick approve/reject buttons for pending AI tasks */}
        {isPendingApproval && onApprove && onReject && (
          <HStack spacing={2} pt={2} borderTopWidth="1px" borderColor={borderColor}>
            <Button
              size="xs"
              colorScheme="green"
              leftIcon={<CheckIcon />}
              onClick={(e) => { e.stopPropagation(); onApprove(task._id); }}
              flex={1}
            >
              Approve
            </Button>
            <Button
              size="xs"
              colorScheme="red"
              variant="outline"
              leftIcon={<CloseIcon />}
              onClick={(e) => { e.stopPropagation(); onReject(task._id); }}
              flex={1}
            >
              Reject
            </Button>
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

function TaskColumn({
  title,
  tasks,
  color,
  statusId,
  onStatusChange,
  onAddTask,
  onApprove,
  onReject,
  onTaskClick,
  onArchive,
  onDelete,
  onConfirmLikelyDone,
  onRejectLikelyDone
}: {
  title: string;
  tasks: Task[];
  color: string;
  statusId: Task['status'];
  onStatusChange: (taskId: string, status: string) => void;
  onAddTask: () => void;
  onApprove?: (taskId: string) => void;
  onReject?: (taskId: string) => void;
  onTaskClick?: (task: Task) => void;
  onArchive?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onConfirmLikelyDone?: (taskId: string) => void;
  onRejectLikelyDone?: (taskId: string) => void;
}) {
  const columnBg = useColorModeValue('gray.50', 'gray.800');
  const overBg = useColorModeValue('blue.50', 'blue.900');
  const pendingCount = tasks.filter(t => t.aiExtracted && t.approval?.status === 'pending').length;
  const { setNodeRef, isOver } = useDroppable({ id: statusId });

  return (
    <Box
      ref={setNodeRef}
      bg={isOver ? overBg : columnBg}
      borderRadius="lg"
      p={4}
      minH="500px"
      w="100%"
      borderWidth="2px"
      borderColor={isOver ? 'blue.300' : 'transparent'}
      transition="background-color 0.15s ease, border-color 0.15s ease"
    >
      <HStack mb={4} justify="space-between">
        <HStack>
          <Box w={3} h={3} borderRadius="full" bg={color} />
          <Text fontWeight="bold" fontSize="md">
            {title}
          </Text>
          <Badge borderRadius="full" px={2}>
            {tasks.length}
          </Badge>
          {pendingCount > 0 && (
            <Badge colorScheme="yellow" borderRadius="full" px={2}>
              {pendingCount} pending
            </Badge>
          )}
        </HStack>
        <IconButton
          aria-label="Add task"
          icon={<AddIcon />}
          size="sm"
          variant="ghost"
          onClick={onAddTask}
        />
      </HStack>

      <VStack spacing={0} align="stretch">
        {tasks.map((task) => (
          <TaskCard
            key={task._id}
            task={task}
            onStatusChange={onStatusChange}
            onApprove={onApprove}
            onReject={onReject}
            onClick={onTaskClick}
            onArchive={onArchive}
            onDelete={onDelete}
            onConfirmLikelyDone={onConfirmLikelyDone}
            onRejectLikelyDone={onRejectLikelyDone}
          />
        ))}
        {tasks.length === 0 && (
          <Box px={3} py={6} textAlign="center">
            <Text color="gray.400" fontSize="sm">No tasks yet</Text>
            <Text color="gray.400" fontSize="xs" mt={1}>Record a meeting and review the action items, or create a task manually.</Text>
          </Box>
        )}
      </VStack>
    </Box>
  );
}

interface SnoozedTask extends Task {
  snoozedAt?: string | null;
  snoozedReason?: string | null;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

function humanSnoozedReason(reason: string | null | undefined): string {
  if (!reason) return 'snoozed';
  if (reason === 'stale-30d') return 'auto-snoozed — no activity for 30+ days';
  if (reason === 'manual') return 'snoozed manually';
  return reason;
}

function SnoozedRow({
  task,
  onBringBack,
}: {
  task: SnoozedTask;
  onBringBack: (id: string) => void;
}) {
  return (
    <Box
      p={4}
      mb={2}
      bg="white"
      borderRadius="8px"
      borderWidth="1px"
      borderColor="gray.200"
      _hover={{ borderColor: 'gray.300', boxShadow: 'sm' }}
    >
      <HStack justify="space-between" align="start" spacing={4}>
        <Box flex="1" minW={0}>
          <Text fontSize="sm" fontWeight="600" noOfLines={1}>
            {task.title}
          </Text>
          <HStack spacing={3} mt={1} flexWrap="wrap">
            {task.dueDate && (
              <Text fontSize="xs" color="gray.500">
                Due {new Date(task.dueDate).toLocaleDateString()}
              </Text>
            )}
            {task.snoozedAt && (
              <Text fontSize="xs" color="gray.500">
                Snoozed {formatRelative(task.snoozedAt)}
              </Text>
            )}
            <Text fontSize="xs" color="gray.600" fontStyle="italic">
              {humanSnoozedReason(task.snoozedReason)}
            </Text>
          </HStack>
        </Box>
        <Button
          size="sm"
          colorScheme="teal"
          variant="outline"
          onClick={() => onBringBack(task._id)}
          flexShrink={0}
        >
          Bring back
        </Button>
      </HStack>
    </Box>
  );
}

export default function TasksDashboard({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTaskStatus, setNewTaskStatus] = useState<'todo' | 'inProgress' | 'completed'>('todo');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [sidebarTaskId, setSidebarTaskId] = useState<string | null>(null);
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [filter, setFilter] = useState<'board' | 'snoozed'>('board');
  const [snoozedTasks, setSnoozedTasks] = useState<SnoozedTask[]>([]);
  const [snoozedLoading, setSnoozedLoading] = useState(false);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const { isOpen: isSidebarOpen, onOpen: onSidebarOpen, onClose: onSidebarClose } = useDisclosure();
  const { isOpen: isEditOpen, onOpen: onEditOpen, onClose: onEditClose } = useDisclosure();
  const { isOpen: isDeleteOpen, onOpen: onDeleteOpen, onClose: onDeleteClose } = useDisclosure();
  const { isOpen: isPriorityReviewOpen, onOpen: onPriorityReviewOpen, onClose: onPriorityReviewClose } = useDisclosure();
  const deleteRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const [data, scoredResult] = await Promise.all([
        api.getTasks(),
        api.getScoredTasks?.().catch(() => ({ scoredTasks: [] })) || { scoredTasks: [] },
      ]);
      // Merge scores into tasks
      const scored = Array.isArray(scoredResult) ? scoredResult : (scoredResult?.scoredTasks || []);
      const scoreMap = new Map<string, any>();
      for (const s of (scored || [])) scoreMap.set(s._id, s);
      const merged = (data || []).map((t: any) => {
        const s = scoreMap.get(t._id);
        return s ? { ...t, priorityScore: s.score, priorityReasoning: s.reasoning } : t;
      });
      // Sort by score (highest first) for non-completed, keep completed at end
      merged.sort((a: any, b: any) => {
        if (a.status === 'completed' && b.status !== 'completed') return 1;
        if (a.status !== 'completed' && b.status === 'completed') return -1;
        return (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
      });
      setTasks(merged);
    } catch {
      setError('Failed to fetch tasks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTasks(); }, []);

  const fetchSnoozedTasks = useCallback(async () => {
    try {
      setSnoozedLoading(true);
      const data = await api.getSnoozedTasks();
      setSnoozedTasks((data || []) as SnoozedTask[]);
    } catch {
      /* non-fatal — badge/list stays at previous value */
    } finally {
      setSnoozedLoading(false);
    }
  }, []);

  // Fetch snoozed count on mount (for badge) and whenever entering Snoozed view
  useEffect(() => { fetchSnoozedTasks(); }, [fetchSnoozedTasks]);
  useEffect(() => {
    if (filter === 'snoozed') fetchSnoozedTasks();
  }, [filter, fetchSnoozedTasks]);

  const handleBringBack = async (taskId: string) => {
    try {
      await api.bringBackTask(taskId);
      setSnoozedTasks(prev => prev.filter(t => t._id !== taskId));
      toast({ title: 'Brought back — back in your active list.', status: 'success', duration: 3000 });
      fetchTasks();
    } catch {
      toast({ title: 'Bring back failed', status: 'error', duration: 3000 });
    }
  };

  const handleBringBackAll = async () => {
    try {
      const result = await api.bringBackAllTasks();
      const count = (result && typeof result === 'object' && 'count' in result) ? (result as any).count : snoozedTasks.length;
      setSnoozedTasks([]);
      toast({ title: `Brought back ${count} task${count === 1 ? '' : 's'}`, status: 'success', duration: 3000 });
      fetchTasks();
    } catch {
      toast({ title: 'Bring back all failed', status: 'error', duration: 3000 });
    }
  };

  // Auto-refresh when tasks are reprioritized after a meeting
  useEffect(() => {
    const onReprioritized = () => fetchTasks();
    api.on?.('tasks:reprioritized', onReprioritized);
    return () => { api.off?.('tasks:reprioritized', onReprioritized); };
  }, []);

  // Auto-refresh when the inference pipeline flags tasks as likely-done
  useEffect(() => {
    const onLikelyDoneUpdated = () => fetchTasks();
    api.on?.('tasks:likely-done-updated', onLikelyDoneUpdated);
    return () => { api.off?.('tasks:likely-done-updated', onLikelyDoneUpdated); };
  }, []);

  // Jira sync details modal
  const [jiraSyncDetails, setJiraSyncDetails] = useState<{ created?: number; linked?: number; total?: number; updated?: number; pulled?: number; items?: any[] } | null>(null);
  const { isOpen: isJiraSyncOpen, onOpen: onJiraSyncOpen, onClose: onJiraSyncClose } = useDisclosure();

  // Auto-refresh when Jira sync occurs (toast handled by Communications)
  useEffect(() => {
    const onJiraAutoSynced = (data: any) => {
      fetchTasks();
      setJiraSyncDetails(data);
    };
    api.on?.('jira:auto-synced', onJiraAutoSynced);
    return () => { api.off?.('jira:auto-synced', onJiraAutoSynced); };
  }, []);

  // Keyboard shortcut: Shift+A to bulk approve all pending tasks
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'A' && pendingApprovalCount > 0) {
        e.preventDefault();
        handleBulkApprove();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tasks]);

  const handleAddTask = (status: 'todo' | 'inProgress' | 'completed' = 'todo') => {
    setNewTaskStatus(status);
    onOpen();
  };

  const handleTaskClick = (task: Task) => {
    setSidebarTaskId(task._id);
    onSidebarOpen();
  };

  const handleSidebarEditClick = (task: any) => {
    setSelectedTask(task);
    onSidebarClose();
    onEditOpen();
  };

  const handleStatusChange = async (taskId: string, newStatus: string) => {
    const task = tasks.find(t => t._id === taskId);
    const oldStatus = task?.status;
    try {
      await api.updateTask(taskId, { status: newStatus });
      setTasks(prev => prev.map(t =>
        t._id === taskId ? { ...t, status: newStatus as Task['status'] } : t
      ));
      const labels: Record<string, string> = { todo: 'To Do', inProgress: 'In Progress', completed: 'Completed' };
      toast({ title: `Moved to ${labels[newStatus] || newStatus}`, status: 'info', duration: 2000 });
    } catch {
      toast({ title: 'Failed to update task', status: 'error', duration: 3000 });
    }
  };

  const handleApprove = async (taskId: string) => {
    try {
      await api.updateTask(taskId, { approval: { status: 'approved' } });
      setTasks(prev => prev.map(t =>
        t._id === taskId
          ? { ...t, approval: { ...t.approval, status: 'approved' } as TaskApproval }
          : t
      ));
      toast({ title: 'Task approved', status: 'success', duration: 2000 });
    } catch {
      toast({ title: 'Approval failed', status: 'error', duration: 3000 });
    }
  };

  const handleReject = async (taskId: string) => {
    try {
      await api.updateTask(taskId, { approval: { status: 'rejected' } });
      setTasks(prev => prev.filter(t => t._id !== taskId));
      toast({ title: 'Task rejected', status: 'info', duration: 2000 });
    } catch {
      toast({ title: 'Rejection failed', status: 'error', duration: 3000 });
    }
  };

  const handleBulkApprove = async () => {
    const pending = tasks.filter(t => t.aiExtracted && t.approval?.status === 'pending');
    if (pending.length === 0) return;
    for (const t of pending) {
      await handleApprove(t._id);
    }
  };

  const handleConfirmLikelyDone = async (taskId: string) => {
    try {
      await api.confirmLikelyDone(taskId);
      setTasks(prev => prev.map(t =>
        t._id === taskId
          ? { ...t, likelyDone: false, status: 'completed' as Task['status'] }
          : t
      ));
      toast({ title: 'Marked done', status: 'success', duration: 2000 });
    } catch {
      toast({ title: 'Failed to mark done', status: 'error', duration: 3000 });
    }
  };

  const handleRejectLikelyDone = async (taskId: string) => {
    try {
      await api.rejectLikelyDone(taskId);
      setTasks(prev => prev.map(t =>
        t._id === taskId ? { ...t, likelyDone: false } : t
      ));
      toast({ title: 'Kept as-is', status: 'info', duration: 2000 });
    } catch {
      toast({ title: 'Failed to update', status: 'error', duration: 3000 });
    }
  };

  const handleArchive = async (taskId: string) => {
    try {
      await api.updateTask(taskId, { archivedAt: new Date().toISOString() });
      setTasks(prev => prev.filter(t => t._id !== taskId));
      toast({ title: 'Task archived', status: 'info', duration: 2000 });
    } catch {
      toast({ title: 'Archive failed', status: 'error', duration: 3000 });
    }
  };

  const handleDeleteRequest = (taskId: string) => {
    setDeleteTaskId(taskId);
    onDeleteOpen();
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTaskId) return;
    onDeleteClose();
    try {
      await api.deleteTask(deleteTaskId);
      setTasks(prev => prev.filter(t => t._id !== deleteTaskId));
      toast({ title: 'Task deleted', status: 'success', duration: 2000 });
    } catch {
      toast({ title: 'Delete failed', status: 'error', duration: 3000 });
    } finally {
      setDeleteTaskId(null);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const dragged = tasks.find(t => t._id === event.active.id);
    setActiveTask(dragged ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    if (!over) return;
    const newStatus = over.id as Task['status'];
    const task = tasks.find(t => t._id === active.id);
    if (task && task.status !== newStatus) {
      handleStatusChange(String(active.id), newStatus);
    }
  };

  const handleApplyPriorityChanges = useCallback(async (changes: PriorityChange[]) => {
    let applied = 0;
    for (const change of changes) {
      try {
        await api.updateTask(change.taskId || change._id, { priority: change.suggestedPriority });
        applied++;
      } catch {
        /* continue with remaining */
      }
    }

    // Optimistic update local state
    setTasks(prev => prev.map(t => {
      const match = changes.find(c => (c.taskId || c._id) === t._id);
      return match ? { ...t, priority: match.suggestedPriority as Task['priority'] } : t;
    }));

    toast({
      title: 'Priorities Updated',
      description: `Applied ${applied} of ${changes.length} priority changes`,
      status: 'success',
      duration: 4000,
      isClosable: true
    });
  }, [toast]);

  // Only show approved/non-AI tasks on the board — pending tasks go through TranscriptReviewModal first
  const approvedTasks = tasks.filter(t => !t.aiExtracted || t.approval?.status !== 'pending');
  const todoTasks = approvedTasks.filter(t => t.status === 'todo');
  const inProgressTasks = approvedTasks.filter(t => t.status === 'inProgress');
  const completedTasks = approvedTasks.filter(t => t.status === 'completed');
  const pendingApprovalCount = tasks.filter(t => t.aiExtracted && t.approval?.status === 'pending').length;

  if (loading) {
    return (
      <Flex pt={{ base: '20px', md: '10px', xl: '10px' }} justify="center" align="center" h="50vh">
        <Spinner size="xl" />
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex pt={{ base: '20px', md: '10px', xl: '10px' }} justify="center" align="center" h="50vh">
        <VStack>
          <Text color="red.500">{error}</Text>
          <Button onClick={fetchTasks}>Retry</Button>
        </VStack>
      </Flex>
    );
  }

  return (
    <Box pt={{ base: '20px', md: '10px', xl: '10px' }}>
      <HStack spacing={2} mb={4}>
        <Button
          size="sm"
          variant={filter === 'board' ? 'solid' : 'ghost'}
          colorScheme={filter === 'board' ? 'brand' : 'gray'}
          borderRadius="full"
          onClick={() => setFilter('board')}
        >
          Board
        </Button>
        <Button
          size="sm"
          variant={filter === 'snoozed' ? 'solid' : 'ghost'}
          colorScheme={filter === 'snoozed' ? 'brand' : 'gray'}
          borderRadius="full"
          onClick={() => setFilter('snoozed')}
          rightIcon={snoozedTasks.length > 0 ? (
            <Badge colorScheme={filter === 'snoozed' ? 'whiteAlpha' : 'gray'} borderRadius="full" px={2}>
              {snoozedTasks.length}
            </Badge>
          ) : undefined}
        >
          Snoozed
        </Button>
      </HStack>

      <Flex justify="flex-end" align="center" mb={6} gap={3}>
        {pendingApprovalCount > 0 && filter === 'board' && (
          <Badge colorScheme="yellow" fontSize="sm" px={3} py={1} borderRadius="full" mr="auto">
            {pendingApprovalCount} pending approval
          </Badge>
        )}
        <HStack spacing={3}>
          {pendingApprovalCount > 0 && (
            <Tooltip label="Keyboard: Shift+A" placement="bottom">
              <Button
                leftIcon={<CheckIcon />}
                colorScheme="green"
                size="sm"
                onClick={handleBulkApprove}
              >
                Approve All ({pendingApprovalCount})
              </Button>
            </Tooltip>
          )}
          <Tooltip label="Score tasks and review suggested priority changes" placement="bottom">
            <Button
              leftIcon={<StarIcon />}
              colorScheme="brand"
              variant="outline"
              size="sm"
              onClick={onPriorityReviewOpen}
            >
              Review Priorities
            </Button>
          </Tooltip>
          <Button leftIcon={<AddIcon />} colorScheme="brand" size="sm" onClick={() => handleAddTask('todo')}>
            New Task
          </Button>
        </HStack>
      </Flex>

      {pendingApprovalCount > 0 && filter === 'board' && (
        <Box mb={4} px={4} py={3} borderRadius="8px" bg="orange.50" border="1px solid" borderColor="orange.200">
          <HStack spacing={3}>
            <Box w="8px" h="8px" borderRadius="full" bg="orange.400" />
            <Text fontSize="sm" color="orange.700" fontWeight="500">
              {pendingApprovalCount} new item{pendingApprovalCount !== 1 ? 's' : ''} from meetings waiting for review.
              Go to <Text as="span" fontWeight="700" cursor="pointer" textDecoration="underline" onClick={() => onNavigate?.('communications')}>Communications</Text> to review and approve.
            </Text>
          </HStack>
        </Box>
      )}

      {filter === 'snoozed' && (
        <Box>
          {snoozedLoading ? (
            <Flex justify="center" py={10}><Spinner /></Flex>
          ) : snoozedTasks.length === 0 ? (
            <Box px={6} py={10} textAlign="center" bg="gray.50" borderRadius="8px">
              <Text color="gray.500" fontSize="sm">No snoozed tasks.</Text>
              <Text color="gray.400" fontSize="xs" mt={1}>
                Tasks are auto-snoozed after 30+ days without activity. They will show up here with a one-click bring-back.
              </Text>
            </Box>
          ) : (
            <Box>
              <HStack justify="space-between" mb={3}>
                <Text fontSize="sm" color="gray.600">
                  {snoozedTasks.length} snoozed task{snoozedTasks.length === 1 ? '' : 's'}
                </Text>
                <Button
                  size="sm"
                  colorScheme="teal"
                  variant="outline"
                  onClick={handleBringBackAll}
                >
                  Bring back all ({snoozedTasks.length})
                </Button>
              </HStack>
              {snoozedTasks.map((t) => (
                <SnoozedRow key={t._id} task={t} onBringBack={handleBringBack} />
              ))}
            </Box>
          )}
        </Box>
      )}

      {filter === 'board' && (
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <SimpleGrid columns={{ base: 1, md: 3 }} spacing={6}>
          <TaskColumn
            title="To Do"
            tasks={todoTasks}
            color="gray.400"
            statusId="todo"
            onStatusChange={handleStatusChange}
            onAddTask={() => handleAddTask('todo')}
            onApprove={handleApprove}
            onReject={handleReject}
            onTaskClick={handleTaskClick}
            onArchive={handleArchive}
            onDelete={handleDeleteRequest}
            onConfirmLikelyDone={handleConfirmLikelyDone}
            onRejectLikelyDone={handleRejectLikelyDone}
          />
          <TaskColumn
            title="In Progress"
            tasks={inProgressTasks}
            color="blue.400"
            statusId="inProgress"
            onStatusChange={handleStatusChange}
            onAddTask={() => handleAddTask('inProgress')}
            onApprove={handleApprove}
            onReject={handleReject}
            onTaskClick={handleTaskClick}
            onArchive={handleArchive}
            onDelete={handleDeleteRequest}
            onConfirmLikelyDone={handleConfirmLikelyDone}
            onRejectLikelyDone={handleRejectLikelyDone}
          />
          <TaskColumn
            title="Completed"
            tasks={completedTasks}
            color="green.400"
            statusId="completed"
            onStatusChange={handleStatusChange}
            onAddTask={() => handleAddTask('completed')}
            onApprove={handleApprove}
            onReject={handleReject}
            onTaskClick={handleTaskClick}
            onArchive={handleArchive}
            onDelete={handleDeleteRequest}
            onConfirmLikelyDone={handleConfirmLikelyDone}
            onRejectLikelyDone={handleRejectLikelyDone}
          />
        </SimpleGrid>

        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <TaskCard
              task={activeTask}
              onStatusChange={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              isOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      )}

      <CreateTaskModal
        isOpen={isOpen}
        onClose={onClose}
        onTaskCreated={fetchTasks}
        defaultStatus={newTaskStatus}
      />

      <EditTaskModal
        isOpen={isEditOpen}
        onClose={onEditClose}
        onTaskUpdated={fetchTasks}
        task={selectedTask}
      />

      <TaskDetailSidebar
        taskId={sidebarTaskId}
        isOpen={isSidebarOpen}
        onClose={onSidebarClose}
        onEditClick={handleSidebarEditClick}
        onTaskUpdated={fetchTasks}
      />

      <AlertDialog
        isOpen={isDeleteOpen}
        leastDestructiveRef={deleteRef}
        onClose={onDeleteClose}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader fontSize="lg" fontWeight="bold">
              Delete Task
            </AlertDialogHeader>
            <AlertDialogBody>
              This will permanently delete the task. This cannot be undone.
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={deleteRef} onClick={onDeleteClose}>
                Cancel
              </Button>
              <Button colorScheme="red" onClick={handleDeleteConfirm} ml={3}>
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>

      <PriorityReviewModal
        isOpen={isPriorityReviewOpen}
        onClose={onPriorityReviewClose}
        onApplyChanges={handleApplyPriorityChanges}
      />

      {/* Jira Sync Details Modal */}
      <Modal isOpen={isJiraSyncOpen} onClose={onJiraSyncClose} motionPreset="scale" size="lg">
        <FlowModalOverlay />
        <FlowModalContent>
          <FlowModalHeader
            title="Jira Sync Summary"
            subtitle={jiraSyncDetails ? (() => {
              const parts: string[] = [];
              if (jiraSyncDetails.created) parts.push(`${jiraSyncDetails.created} created`);
              if (jiraSyncDetails.linked) parts.push(`${jiraSyncDetails.linked} linked`);
              if (jiraSyncDetails.updated) parts.push(`${jiraSyncDetails.updated} updated`);
              if (jiraSyncDetails.pulled) parts.push(`${jiraSyncDetails.pulled} pulled from Jira`);
              return parts.join(' · ') || 'Sync complete';
            })() : undefined}
          />
          <FlowModalBody>
            {jiraSyncDetails && (
              <VStack align="stretch" spacing={3}>
                {jiraSyncDetails.created && jiraSyncDetails.created > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="green.50" borderWidth="1px" borderColor="green.200">
                    <HStack spacing={2}>
                      <Badge colorScheme="green" fontSize="xs">NEW</Badge>
                      <Text fontSize="sm" fontWeight="600">{jiraSyncDetails.created} task{jiraSyncDetails.created !== 1 ? 's' : ''} pushed to Jira</Text>
                    </HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>New Jira issues created from meeting action items</Text>
                  </Box>
                )}
                {jiraSyncDetails.linked && jiraSyncDetails.linked > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="blue.50" borderWidth="1px" borderColor="blue.200">
                    <HStack spacing={2}>
                      <Badge colorScheme="blue" fontSize="xs">LINKED</Badge>
                      <Text fontSize="sm" fontWeight="600">{jiraSyncDetails.linked} task{jiraSyncDetails.linked !== 1 ? 's' : ''} linked to existing stories</Text>
                    </HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>Matched to existing Jira stories with high confidence</Text>
                  </Box>
                )}
                {jiraSyncDetails.updated && jiraSyncDetails.updated > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="brand.50" borderWidth="1px" borderColor="brand.200">
                    <HStack spacing={2}>
                      <Badge colorScheme="brand" fontSize="xs">UPDATED</Badge>
                      <Text fontSize="sm" fontWeight="600">{jiraSyncDetails.updated} task{jiraSyncDetails.updated !== 1 ? 's' : ''} synced to Jira</Text>
                    </HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>Status and field changes pushed to Jira</Text>
                  </Box>
                )}
                {jiraSyncDetails.pulled && jiraSyncDetails.pulled > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="purple.50" borderWidth="1px" borderColor="purple.200">
                    <HStack spacing={2}>
                      <Badge colorScheme="purple" fontSize="xs">PULLED</Badge>
                      <Text fontSize="sm" fontWeight="600">{jiraSyncDetails.pulled} update{jiraSyncDetails.pulled !== 1 ? 's' : ''} from Jira</Text>
                    </HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>Jira issue changes synced to your local tasks</Text>
                  </Box>
                )}
                {jiraSyncDetails.items && jiraSyncDetails.items.length > 0 && (
                  <Box mt={2}>
                    <Text fontSize="xs" fontWeight="700" color="gray.500" mb={2} textTransform="uppercase">Details</Text>
                    <VStack align="stretch" spacing={1}>
                      {jiraSyncDetails.items.map((item: any, i: number) => (
                        <HStack key={i} px={3} py={2} bg="gray.50" borderRadius="6px" spacing={2}>
                          <Badge colorScheme="gray" fontSize="9px">{item.jiraKey || '—'}</Badge>
                          <Text fontSize="xs" flex={1} noOfLines={1}>{item.title || item.text || 'Untitled'}</Text>
                          <Badge colorScheme={item.action === 'created' ? 'green' : item.action === 'linked' ? 'blue' : 'gray'} fontSize="9px">{item.action || 'synced'}</Badge>
                        </HStack>
                      ))}
                    </VStack>
                  </Box>
                )}
              </VStack>
            )}
          </FlowModalBody>
          <FlowModalFooter onCancel={onJiraSyncClose} cancelLabel="Close" />
        </FlowModalContent>
      </Modal>
    </Box>
  );
}
