import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Flex, Text, VStack, HStack, Badge, useColorModeValue, Spinner,
  Button, useDisclosure, useToast, AlertDialog, AlertDialogBody,
  AlertDialogFooter, AlertDialogHeader, AlertDialogContent, AlertDialogOverlay,
  IconButton, Divider, Icon, Collapse, Grid, Tooltip, Modal
} from '@chakra-ui/react';
import {
  ChevronLeftIcon, ChevronRightIcon, AddIcon, DeleteIcon, CalendarIcon,
  CheckIcon, WarningIcon, ChatIcon, RepeatIcon, CloseIcon
} from '@chakra-ui/icons';
import { FiMail, FiMessageSquare, FiVideo, FiCalendar, FiChevronDown, FiChevronUp } from 'react-icons/fi';
import Card from './components/card/Card';
import TranscriptUploadModal from './views/communications/TranscriptUploadModal';
import TranscriptReviewModal from './views/communications/TranscriptReviewModal';
import JiraMappingModal from './views/communications/JiraMappingModal';
import { FlowModalOverlay, FlowModalContent, FlowModalHeader, FlowModalBody, FlowModalFooter } from './components/modal/FlowModalShell';
import { api } from './api';

// ── Types ──────────────────────────────────────────────────────────────────

interface Meeting {
  _id: string;
  title: string;
  date: string | number;
  duration: number;
  attendees: string[];
  hasTranscript: boolean;
  hasInsights: boolean;
  actionItemCount: number;
  blockerCount: number;
  decisionCount: number;
  commitmentCount: number; // derived from actionItems with isCommitment
  contradictionCount: number;
  status: 'pending' | 'processed' | 'reviewed' | 'transcribed' | 'recording';
  source: 'db' | 'calendar';
  meetingUrl?: string;
  calendarEventId?: string;
}

// ── Static helpers ─────────────────────────────────────────────────────────

const MEETING_TIPS = [
  'Send agenda 24h ahead', 'Assign a note-taker', 'Time-box each topic',
  'End with clear next steps', 'Limit to key attendees', 'Start with a 2-min check-in'
];

const AGENDA_TEMPLATES: Record<string, string[]> = {
  default: ['Review previous action items', 'Main discussion topics', 'Blockers & risks', 'Next steps & owners'],
  standup: ['What did you complete?', 'What are you working on today?', 'Any blockers?'],
  review: ['Demo & walkthrough', 'Feedback & questions', 'Action items & follow-ups'],
  planning: ['Sprint goals review', 'Backlog refinement', 'Capacity & assignments', 'Risks & dependencies'],
  '1on1': ['Personal check-in', 'Progress on goals', 'Feedback & growth', 'Open topics'],
};

function getAgendaFor(title: string): string[] {
  const t = title.toLowerCase();
  if (t.includes('standup') || t.includes('scrum') || t.includes('daily')) return AGENDA_TEMPLATES.standup;
  if (t.includes('review') || t.includes('demo')) return AGENDA_TEMPLATES.review;
  if (t.includes('planning') || t.includes('sprint')) return AGENDA_TEMPLATES.planning;
  if (t.includes('1:1') || t.includes('1-1') || t.includes('one on one') || t.includes('1 on 1')) return AGENDA_TEMPLATES['1on1'];
  return AGENDA_TEMPLATES.default;
}

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── Main component ─────────────────────────────────────────────────────────

export default function CommunicationCenter() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteMeetingId, setDeleteMeetingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);

  const { isOpen: isUploadOpen, onOpen: onUploadOpen, onClose: onUploadClose } = useDisclosure();
  const { isOpen: isDeleteOpen, onOpen: onDeleteOpen, onClose: onDeleteClose } = useDisclosure();
  const { isOpen: isReviewOpen, onOpen: onReviewOpen, onClose: onReviewClose } = useDisclosure();
  const { isOpen: isJiraSyncOpen, onOpen: onJiraSyncOpen, onClose: onJiraSyncClose } = useDisclosure();
  const [jiraSyncDetails, setJiraSyncDetails] = useState<any>(null);

  const [reviewMeetingData, setReviewMeetingData] = useState<Meeting | null>(null);
  const [expandedMeetings, setExpandedMeetings] = useState<Set<string>>(new Set());
  const [meetingInsights, setMeetingInsights] = useState<Record<string, any>>({});
  const [loadingInsightsFor, setLoadingInsightsFor] = useState<string | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [briefing, setBriefing] = useState<any>(null);
  const [briefingDismissed, setBriefingDismissed] = useState(false);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [jiraMappingMeeting, setJiraMappingMeeting] = useState<{ id: string; title: string; actionItems: any[] } | null>(null);
  const [meetingAgendas, setMeetingAgendas] = useState<Record<string, string[]>>({});
  const [loadingAgendaFor, setLoadingAgendaFor] = useState<string | null>(null);

  const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const [selectedDate, setSelectedDate] = useState<Date>(todayStart);
  const [calMonth, setCalMonth] = useState<Date>(new Date());

  const toast = useToast();
  const borderColor    = useColorModeValue('gray.200', 'gray.600');
  const cardBg         = useColorModeValue('white', 'gray.800');
  const hoverBg        = useColorModeValue('gray.50', 'gray.700');
  const todayBg        = useColorModeValue('brand.500', 'brand.400');
  const selectedBg     = useColorModeValue('brand.50', 'brand.900');
  const selectedBorder = useColorModeValue('brand.400', 'brand.500');
  const mutedText      = useColorModeValue('gray.500', 'gray.400');
  const sectionHeading = useColorModeValue('gray.400', 'gray.500');

  // ── Data fetch ─────────────────────────────────────────────────────────────

  const fetchMeetings = useCallback(async () => {
    try {
      setLoading(true);
      const [dbMeetings, calEvents, config] = await Promise.all([
        api.getMeetings(),
        api.getCalendarEvents(),
        api.getConfig(),
      ]);

      setCalendarConnected(!!(config?.googleIcsUrl || config?.outlookIcsUrl));

      const fromDb: Meeting[] = (dbMeetings || []).map((m: any) => ({
        _id: m._id || m.id,
        title: m.title,
        date: m.date,
        duration: m.duration || 0,
        attendees: m.attendees || [],
        hasTranscript: !!m.transcript,
        hasInsights: !!(m.insights?.summary || m.insights?.actionItems?.length),
        actionItemCount: m.insights?.actionItems?.length || m.actionItemCount || 0,
        blockerCount: m.insights?.blockers?.length || m.blockerCount || 0,
        decisionCount: m.insights?.decisions?.length || m.decisionCount || 0,
        commitmentCount: (m.insights?.actionItems || []).filter((a: any) => a.isCommitment).length || m.commitmentCount || 0,
        contradictionCount: m.insights?.contradictions?.length || m.contradictionCount || 0,
        status: m.status,
        source: 'db' as const,
        calendarEventId: m.calendarEventId,
      }));

      const fromCal: Meeting[] = (calEvents || []).map((e: any) => ({
        _id: e.id,
        title: e.title || e.summary || 'Untitled',
        date: e.startTime,
        duration: 0,
        attendees: e.attendees || [],
        hasTranscript: false,
        hasInsights: false,
        actionItemCount: 0,
        blockerCount: 0,
        decisionCount: 0,
        commitmentCount: 0,
        contradictionCount: 0,
        status: 'pending' as const,
        source: 'calendar' as const,
        meetingUrl: e.url,
      }));

      const dbCalIds = new Set(fromDb.map((m: any) => (m as any).calendarEventId).filter(Boolean));
      const filteredCal = fromCal.filter(e => !dbCalIds.has(e._id));

      setMeetings([...fromDb, ...filteredCal]);
    } catch {
      setError('Failed to fetch meetings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

  // Fetch morning briefing + Jira status on mount
  useEffect(() => {
    api.getBriefing?.().then((b: any) => {
      if (b) setBriefing(b);
    }).catch(() => {});
    api.jiraStatus?.().then((s: any) => {
      setJiraConnected(!!s?.connected);
    }).catch(() => {});
  }, []);

  // Listen for new meetings recorded
  useEffect(() => {
    const onNewMeeting = () => {
      fetchMeetings();
      // Jump calendar to today so the new meeting is visible
      const today = new Date(); today.setHours(0, 0, 0, 0);
      setSelectedDate(today);
    };
    const onCalEvents = () => fetchMeetings();

    // Batch post-meeting events into a single toast (debounced)
    let pendingUpdates: string[] = [];
    let batchTimeout: ReturnType<typeof setTimeout> | null = null;
    const flushBatch = () => {
      if (pendingUpdates.length === 0) return;
      const lines = [...pendingUpdates];
      pendingUpdates = [];
      toast({
        duration: 6000, isClosable: true, position: 'bottom',
        render: ({ onClose }) => (
          <Box bg="brand.500" color="white" px={5} py={3} borderRadius="xl" boxShadow="lg" cursor="pointer"
            onClick={() => { onClose(); if (latestJiraData) onJiraSyncOpen(); }} _hover={{ bg: 'brand.600' }}>
            <HStack spacing={3}>
              <Box w="24px" h="24px" borderRadius="full" bg="white" display="flex" alignItems="center" justifyContent="center" flexShrink={0}>
                <Text fontSize="12px" fontWeight="800" color="brand.500">&#10003;</Text>
              </Box>
              <Box>
                <Text fontWeight="700" fontSize="sm">Meeting processed</Text>
                <Text fontSize="xs" opacity={0.9}>Click Review on the meeting below to approve action items.</Text>
              </Box>
            </HStack>
          </Box>
        )
      });
    };
    const queueUpdate = (msg: string) => {
      pendingUpdates.push(msg);
      if (batchTimeout) clearTimeout(batchTimeout);
      batchTimeout = setTimeout(flushBatch, 2000); // wait 2s for more events before showing
    };

    let latestJiraData: any = null;

    const onReprioritized = (scored: any[]) => {
      api.getBriefing?.().then((b: any) => { if (b) setBriefing(b); setBriefingDismissed(false); });
      queueUpdate(`${scored.length} tasks rescored`);
    };
    const onJiraAutoSynced = (data: any) => {
      latestJiraData = data;
      setJiraSyncDetails(data);
      const parts: string[] = [];
      if (data.created) parts.push(`${data.created} pushed to Jira`);
      if (data.linked) parts.push(`${data.linked} linked to Jira stories`);
      if (data.pulled) parts.push(`${data.pulled} pulled from Jira`);
      if (data.updated) parts.push(`${data.updated} synced to Jira`);
      if (parts.length > 0) queueUpdate(parts.join(', '));
    };
    api.on('meeting:new', onNewMeeting);
    api.on('calendar:events', onCalEvents);
    // #2: Pipeline error — extraction failed
    const onPipelineError = (data: { meetingId: string; error: string; stage: string }) => {
      fetchMeetings();
      toast({
        title: 'Extraction failed',
        description: data.error?.includes('API key') || data.error?.includes('401')
          ? 'Your API key may be invalid. Check Settings to update it.'
          : `Could not extract insights: ${data.error}. You can upload a transcript manually.`,
        status: 'error',
        duration: 8000,
        isClosable: true,
      });
    };

    api.on('tasks:reprioritized', onReprioritized);
    api.on('jira:auto-synced', onJiraAutoSynced);
    api.on('pipeline:error', onPipelineError);
    return () => {
      if (batchTimeout) clearTimeout(batchTimeout);
      api.off('meeting:new', onNewMeeting); api.off('calendar:events', onCalEvents);
      api.off('tasks:reprioritized', onReprioritized); api.off('jira:auto-synced', onJiraAutoSynced);
      api.off('pipeline:error', onPipelineError);
    };
  }, [fetchMeetings, toast]);

  // ── Insights ───────────────────────────────────────────────────────────────

  const fetchInsightsForMeeting = async (meeting: Meeting) => {
    if (meetingInsights[meeting._id]) return;
    setLoadingInsightsFor(meeting._id);
    try {
      const data = await api.getMeeting(meeting._id);
      if (data?.insights) {
        setMeetingInsights(prev => ({ ...prev, [meeting._id]: data.insights }));
      }
    } finally {
      setLoadingInsightsFor(null);
    }
  };

  const toggleExpand = (meeting: Meeting) => {
    const next = new Set(expandedMeetings);
    if (next.has(meeting._id)) {
      next.delete(meeting._id);
    } else {
      next.add(meeting._id);
      if (meeting.source === 'db' && (meeting.status === 'reviewed' || meeting.status === 'processed')) {
        fetchInsightsForMeeting(meeting);
      }
    }
    setExpandedMeetings(next);
  };

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDeleteRequest = (meetingId: string) => { setDeleteMeetingId(meetingId); onDeleteOpen(); };

  const handleDeleteConfirm = async () => {
    if (!deleteMeetingId) return;
    setIsDeleting(true);
    try {
      await api.deleteMeeting(deleteMeetingId);
      setMeetings(prev => prev.filter(m => m._id !== deleteMeetingId));
      toast({ title: 'Meeting deleted', status: 'success', duration: 3000 });
    } catch {
      toast({ title: 'Delete failed', status: 'error', duration: 3000 });
    } finally {
      setIsDeleting(false);
      onDeleteClose();
      setDeleteMeetingId(null);
    }
  };

  // ── Review ─────────────────────────────────────────────────────────────────

  const handleOpenReview = (meeting: Meeting) => {
    setReviewMeetingData(meeting);
    onReviewOpen();
  };

  const handleReviewApproved = async (meetingId: string) => {
    await api.reviewMeeting(meetingId);
    setMeetings(prev => prev.map(m => m._id === meetingId ? { ...m, status: 'reviewed' } : m));
    const data = await api.getMeeting(meetingId);
    if (data?.insights) setMeetingInsights(prev => ({ ...prev, [meetingId]: data.insights }));
    setExpandedMeetings(prev => new Set([...prev, meetingId]));
  };

  // ── Upload transcript ─────────────────────────────────────────────────────

  const handleUploadTranscript = async (transcript: { title: string; content: string; date: string }) => {
    const result = await api.createMeetingFromTranscript(transcript);
    await fetchMeetings();
    if (result?.status === 'processed') {
      toast({ title: 'Extraction complete', description: 'Action items extracted — review below', status: 'success', duration: 3000 });
    }
  };

  // ── AI agenda for upcoming meetings ────────────────────────────────────────

  const fetchMeetingAgenda = async (meeting: Meeting) => {
    if (meetingAgendas[meeting._id] || loadingAgendaFor === meeting._id) return;
    setLoadingAgendaFor(meeting._id);
    try {
      const result = await api.generateMeetingAgenda(meeting.title, meeting.attendees);
      if (result.agenda?.length) {
        setMeetingAgendas(prev => ({ ...prev, [meeting._id]: result.agenda }));
      }
    } catch {
      // Leave empty so the friendly message shows
    } finally {
      setLoadingAgendaFor(null);
    }
  };

  // ── Calendar helpers ───────────────────────────────────────────────────────

  const parseLocalDate = (dateStr: string | number): Date => {
    // Epoch ms (from calendar events) — construct Date directly, already correct for local TZ
    if (typeof dateStr === 'number') return new Date(dateStr);
    // ISO string from DB meetings — parse as-is (new Date handles ISO correctly)
    return new Date(dateStr);
  };

  const meetingDateStrings = new Set(
    meetings.filter(m => m.date).map(m => parseLocalDate(m.date).toDateString())
  );

  const calYear = calMonth.getFullYear();
  const calMonthIndex = calMonth.getMonth();
  const firstDow = new Date(calYear, calMonthIndex, 1).getDay();
  const daysInMonth = new Date(calYear, calMonthIndex + 1, 0).getDate();

  const prevMonth = () => setCalMonth(new Date(calYear, calMonthIndex - 1, 1));
  const nextMonth = () => setCalMonth(new Date(calYear, calMonthIndex + 1, 1));

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const now = new Date();
  const dayMeetings = meetings.filter(m => m.date && isSameDay(parseLocalDate(m.date), selectedDate));
  const completedMeetings = dayMeetings.filter(m => m.source === 'db' || parseLocalDate(m.date) <= now);
  const upcomingMeetings  = dayMeetings.filter(m => m.source === 'calendar' && parseLocalDate(m.date) > now);

  const formatTime = (dateStr: string | number) => {
    try { return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
    catch { return ''; }
  };

  const formatShortDate = (dateStr: string | number) => {
    try { return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
    catch { return String(dateStr); }
  };

  const formatSelectedDate = (d: Date) =>
    d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // ── Card renderers ────────────────────────────────────────────────────────

  const renderCompletedCard = (meeting: Meeting) => {
    const isExpanded = expandedMeetings.has(meeting._id);
    const insights = meetingInsights[meeting._id];
    const isLoading = loadingInsightsFor === meeting._id;

    return (
      <Box key={meeting._id} border="1px solid" borderColor={borderColor} borderRadius="lg" overflow="hidden" bg={cardBg}>
        <Flex px={4} py={3} align="center" gap={3} cursor="pointer" onClick={() => toggleExpand(meeting)} _hover={{ bg: hoverBg }}>
          <Icon as={ChatIcon as any} color="gray.400" flexShrink={0} />
          <VStack align="start" spacing={0} flex={1} minW={0}>
            <Text fontWeight="semibold" fontSize="sm" noOfLines={1}>{meeting.title}</Text>
            {meeting.attendees.length > 0 && (
              <Text fontSize="xs" color={mutedText} noOfLines={1}>{meeting.attendees.join(', ')}</Text>
            )}
          </VStack>
          <HStack spacing={2} flexShrink={0}>
            {meeting.contradictionCount > 0 && <Badge colorScheme="orange" variant="subtle" borderRadius="full" px={2} fontSize="xs">conflicts ({meeting.contradictionCount})</Badge>}
            {meeting.blockerCount > 0 && <Badge colorScheme="red" variant="subtle" borderRadius="full" px={2} fontSize="xs">blockers ({meeting.blockerCount})</Badge>}
            {meeting.actionItemCount > 0 && <Badge colorScheme="blue" variant="subtle" borderRadius="full" px={2} fontSize="xs">tasks ({meeting.actionItemCount})</Badge>}
            {meeting.commitmentCount > 0 && <Badge colorScheme="purple" variant="subtle" borderRadius="full" px={2} fontSize="xs">commitments ({meeting.commitmentCount})</Badge>}
            {meeting.decisionCount > 0 && <Badge colorScheme="green" variant="subtle" borderRadius="full" px={2} fontSize="xs">decisions ({meeting.decisionCount})</Badge>}
          </HStack>
          <Text fontSize="xs" color="gray.400" flexShrink={0}>{formatTime(meeting.date)}</Text>
          {meeting.status === 'processed' && (
            <Button size="xs" colorScheme="brand" flexShrink={0}
              onClick={e => { e.stopPropagation(); handleOpenReview(meeting); }}>
              Review
            </Button>
          )}
          <IconButton aria-label="Delete meeting" icon={<DeleteIcon />} size="xs" colorScheme="red" variant="ghost"
            flexShrink={0} onClick={e => { e.stopPropagation(); handleDeleteRequest(meeting._id); }} />
          <Icon as={isExpanded ? FiChevronUp : FiChevronDown} color="gray.400" flexShrink={0} />
        </Flex>

        <Collapse in={isExpanded} animateOpacity>
          <Box px={6} py={4} borderTop="1px solid" borderTopColor={borderColor}>
            {meeting.status === 'pending' || meeting.status === 'recording' ? (
              <Text fontSize="sm" color={mutedText}>Processing recording...</Text>
            ) : meeting.status === 'transcribed' ? (
              <Text fontSize="sm" color={mutedText}>Extracting insights...</Text>
            ) : meeting.status === 'processed' ? (
              <Text fontSize="sm" color={mutedText}>Ready for review — click Review to see action items and decisions.</Text>
            ) : isLoading ? (
              <Flex justify="center" py={4}><Spinner size="sm" /></Flex>
            ) : insights ? (
              <VStack align="stretch" spacing={4} divider={<Divider />}>
                {insights.summary && (
                  <Box>
                    <Text fontWeight="semibold" fontSize="sm" mb={1}>Summary</Text>
                    <Text fontSize="sm" color="gray.600">{insights.summary}</Text>
                  </Box>
                )}
                {insights.actionItems?.length > 0 && (
                  <Box>
                    <Text fontWeight="semibold" fontSize="sm" mb={2}>Action Items</Text>
                    <VStack align="stretch" spacing={2}>
                      {insights.actionItems.map((item: any, idx: number) => (
                        <Flex key={idx} align="flex-start" gap={2}>
                          <Box w="5px" h="5px" borderRadius="full" bg={item.isCommitment ? "purple.400" : "gray.400"} mt="6px" flexShrink={0} />
                          <Box flex={1}>
                            <HStack spacing={2}>
                              <Text fontSize="sm">{item.text}</Text>
                              {item.isCommitment && <Badge colorScheme="purple" variant="subtle" borderRadius="full" px={2} fontSize="xs">Commitment</Badge>}
                            </HStack>
                            <HStack spacing={4} mt={1} flexWrap="wrap">
                              {(item.assignee || item.owner)
                                ? <Text fontSize="xs" color={mutedText}>assignee: {item.assignee || item.owner}</Text>
                                : <Text fontSize="xs" color="orange.400">No owner</Text>}
                              {item.dueDate
                                ? <HStack spacing={1}><CalendarIcon color="gray.400" boxSize="10px" /><Text fontSize="xs" color={mutedText}>{formatShortDate(item.dueDate)}</Text></HStack>
                                : <Text fontSize="xs" color="orange.400">No due date</Text>}
                            </HStack>
                          </Box>
                        </Flex>
                      ))}
                    </VStack>
                  </Box>
                )}
                {insights.blockers?.length > 0 && (
                  <Box>
                    <Text fontWeight="semibold" fontSize="sm" mb={2}>Blockers</Text>
                    <VStack align="stretch" spacing={1}>
                      {insights.blockers.map((item: any, idx: number) => (
                        <HStack key={idx} spacing={2}>
                          <WarningIcon color="orange.400" boxSize="12px" flexShrink={0} />
                          <Text fontSize="sm" color="red.500">{item.text || item}</Text>
                        </HStack>
                      ))}
                    </VStack>
                  </Box>
                )}
                {insights.decisions?.length > 0 && (
                  <Box>
                    <Text fontWeight="semibold" fontSize="sm" mb={2}>Key Decisions</Text>
                    <VStack align="stretch" spacing={1}>
                      {insights.decisions.map((item: any, idx: number) => (
                        <HStack key={idx} spacing={2}>
                          <CheckIcon color="green.500" boxSize="10px" flexShrink={0} />
                          <Text fontSize="sm">{item.text || item}</Text>
                        </HStack>
                      ))}
                    </VStack>
                  </Box>
                )}
                {insights.contradictions?.length > 0 && (
                  <Box bg="orange.50" borderRadius="md" p={3} border="1px solid" borderColor="orange.200">
                    <Text fontWeight="semibold" fontSize="sm" mb={2} color="orange.700">Contradictions Detected</Text>
                    <VStack align="stretch" spacing={2}>
                      {insights.contradictions.map((c: any, idx: number) => (
                        <Box key={idx}>
                          <HStack spacing={2} align="flex-start">
                            <WarningIcon color="orange.500" boxSize="12px" flexShrink={0} mt="3px" />
                            <Box>
                              <Text fontSize="sm" color="orange.800">{c.text}</Text>
                              <Text fontSize="xs" color="orange.600" mt={1}>
                                Previous: "{c.previousDecision}"
                                {c.previousMeetingTitle && ` — from "${c.previousMeetingTitle}"`}
                                {c.previousMeetingDate && ` (${c.previousMeetingDate})`}
                              </Text>
                            </Box>
                          </HStack>
                        </Box>
                      ))}
                    </VStack>
                  </Box>
                )}
                {insights.approvedByName && (
                  <Flex justify="flex-end">
                    <Text fontSize="xs" color={mutedText}>
                      Reviewed by {insights.approvedByName}{insights.approvedAt ? ` · ${formatShortDate(insights.approvedAt)}` : ''}
                    </Text>
                  </Flex>
                )}
                {jiraConnected && insights.actionItems?.length > 0 && (
                  <Box pt={2}>
                    <Button size="sm" colorScheme="blue" variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setJiraMappingMeeting({
                          id: meeting._id,
                          title: meeting.title,
                          actionItems: insights.actionItems.map((a: any) => ({ text: a.text, owner: a.owner || a.assignee })),
                        });
                      }}>
                      Map to Jira
                    </Button>
                  </Box>
                )}
              </VStack>
            ) : (
              <Box px={3} py={2} borderRadius="8px" border="1px solid" borderColor="gray.200" bg="gray.50">
                <Text fontSize="12px" color="gray.500">Inwise is still learning about your team and projects. After a few meetings, insights will appear automatically.</Text>
              </Box>
            )}
          </Box>
        </Collapse>
      </Box>
    );
  };

  const renderUpcomingCard = (meeting: Meeting) => {
    const isExpanded = expandedMeetings.has(meeting._id);
    const agenda = meetingAgendas[meeting._id] || null;
    const isLoadingAgenda = loadingAgendaFor === meeting._id;

    return (
      <Box key={meeting._id} border="1.5px solid" borderColor={isExpanded ? selectedBorder : borderColor}
        borderRadius="lg" overflow="hidden" bg={cardBg} transition="border-color 0.15s">
        <Flex px={4} py={3} align="center" gap={3} cursor="pointer" onClick={() => { toggleExpand(meeting); if (!meetingAgendas[meeting._id]) fetchMeetingAgenda(meeting); }} _hover={{ bg: hoverBg }}>
          <Box w="8px" h="8px" borderRadius="full" bg="brand.400" flexShrink={0} mt="2px" />
          <VStack align="start" spacing={0} flex={1} minW={0}>
            <Text fontWeight="semibold" fontSize="sm" noOfLines={1}>{meeting.title}</Text>
            {meeting.attendees.length > 0 && (
              <Text fontSize="xs" color={mutedText} noOfLines={1}>{meeting.attendees.join(', ')}</Text>
            )}
          </VStack>
          <Badge colorScheme="purple" variant="subtle" borderRadius="full" px={2} fontSize="xs">Upcoming</Badge>
          <Text fontSize="xs" color={mutedText} flexShrink={0}>{formatTime(meeting.date)}</Text>
          {meeting.meetingUrl && (
            <Button size="xs" colorScheme="brand" variant="outline" flexShrink={0}
              onClick={e => { e.stopPropagation(); api.openExternal(meeting.meetingUrl!); }}>
              Join
            </Button>
          )}
          <Icon as={isExpanded ? FiChevronUp : FiChevronDown} color="gray.400" flexShrink={0} />
        </Flex>

        <Collapse in={isExpanded} animateOpacity>
          <Box px={5} py={4} borderTop="1px solid" borderTopColor={borderColor}>
            <Flex gap={6} flexWrap="wrap">
              <Box flex={1} minW="160px">
                <Flex align="center" gap={2} mb={2}>
                  <Text fontSize="xs" fontWeight="semibold" color={sectionHeading} textTransform="uppercase" letterSpacing="wide">
                    Suggested Agenda
                  </Text>
                  {agenda && <Badge colorScheme="purple" variant="subtle" fontSize="9px" borderRadius="full" px={1.5}>AI</Badge>}
                  {agenda && (
                    <IconButton
                      aria-label="Regenerate agenda"
                      icon={<RepeatIcon />}
                      size="xs"
                      variant="ghost"
                      isLoading={isLoadingAgenda}
                      onClick={e => { e.stopPropagation(); setMeetingAgendas(prev => { const next = { ...prev }; delete next[meeting._id]; return next; }); fetchMeetingAgenda(meeting); }}
                    />
                  )}
                </Flex>
                {isLoadingAgenda && !agenda ? (
                  <Flex align="center" gap={2}><Spinner size="xs" /><Text fontSize="sm" color={mutedText}>Generating agenda...</Text></Flex>
                ) : agenda ? (
                  <VStack align="start" spacing={1.5}>
                    {agenda.map((item, idx) => (
                      <HStack key={idx} spacing={2} align="start">
                        <Text fontSize="xs" color="brand.400" fontWeight="bold" flexShrink={0} mt="1px">{idx + 1}.</Text>
                        <Text fontSize="sm">{item}</Text>
                      </HStack>
                    ))}
                  </VStack>
                ) : (
                  <Flex align="center" gap={2} bg="brand.50" borderRadius="full" px={3} py={1.5} w="fit-content">
                    <Spinner size="xs" color="brand.400" speed="1.5s" />
                    <Text fontSize="xs" color="brand.600">
                      Inwise needs a bit of time to generate an agenda with AI. Keep using Inwise for sharper future suggestions.
                    </Text>
                  </Flex>
                )}
              </Box>
              <Box minW="160px">
                <Text fontSize="xs" fontWeight="semibold" color={sectionHeading} textTransform="uppercase" letterSpacing="wide" mb={2}>
                  Tips
                </Text>
                <Flex gap={2} flexWrap="wrap">
                  {MEETING_TIPS.slice(0, 4).map((tip, idx) => (
                    <Badge key={idx} colorScheme="teal" variant="subtle" borderRadius="full" px={3} py={1} fontSize="xs">{tip}</Badge>
                  ))}
                </Flex>
              </Box>
            </Flex>
          </Box>
        </Collapse>
      </Box>
    );
  };

  // ── Loading / error ───────────────────────────────────────────────────────

  if (loading) return <Flex justify="center" align="center" h="50vh"><Spinner size="xl" /></Flex>;

  if (error) {
    return (
      <Flex justify="center" align="center" h="50vh">
        <VStack><Text color="red.500">{error}</Text><Button onClick={fetchMeetings}>Retry</Button></VStack>
      </Flex>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Box pt={{ base: '20px', md: '10px', xl: '10px' }}>
      <Flex justify="space-between" align="center" mb={5}>
        <Text fontSize="xl" fontWeight="bold">Communications</Text>
        <HStack spacing={2}>
          <Button leftIcon={<AddIcon />} colorScheme="brand" size="sm" onClick={onUploadOpen}>
            Upload Transcript
          </Button>
          <Tooltip label="Refresh meetings">
            <IconButton aria-label="Refresh" icon={<RepeatIcon />} variant="ghost" size="sm" onClick={fetchMeetings} />
          </Tooltip>
        </HStack>
      </Flex>

      {/* ── Morning Briefing ── */}
      {briefing && !briefingDismissed && (briefing.topTasks?.length > 0 || briefing.overdueCommitments?.length > 0) && (
        <Box mb={5} p={4} bg="white" borderRadius="lg" border="1px solid" borderColor={borderColor} position="relative">
          <IconButton
            aria-label="Dismiss briefing" icon={<CloseIcon />} size="xs" variant="ghost"
            position="absolute" top={2} right={2} onClick={() => setBriefingDismissed(true)}
          />
          <Text fontSize="lg" fontWeight="bold" color="gray.800" mb={3}>{briefing.greeting}</Text>

          {briefing.topTasks?.length > 0 && (
            <Box mb={briefing.overdueCommitments?.length > 0 ? 3 : 0}>
              <Text fontSize="xs" fontWeight="semibold" color={sectionHeading} textTransform="uppercase" letterSpacing="wide" mb={2}>
                Top Priorities ({briefing.totalTasks} total open)
              </Text>
              <VStack align="stretch" spacing={2}>
                {briefing.topTasks.map((task: any, idx: number) => (
                  <Flex key={task._id} align="center" gap={3} px={3} py={2} bg="gray.50" borderRadius="md">
                    <Text fontSize="sm" fontWeight="bold" color="brand.500" w="18px">{idx + 1}.</Text>
                    <Box flex={1}>
                      <Text fontSize="sm" fontWeight="medium">{task.title}</Text>
                      <Text fontSize="xs" color={mutedText}>{task.priorityReasoning}</Text>
                    </Box>
                    <Badge colorScheme={task.priorityScore >= 70 ? 'red' : task.priorityScore >= 40 ? 'orange' : 'gray'}
                      variant="subtle" borderRadius="full" px={2} fontSize="xs">
                      {task.priorityScore}
                    </Badge>
                  </Flex>
                ))}
              </VStack>
            </Box>
          )}

          {briefing.overdueCommitments?.length > 0 && (
            <Box>
              <Text fontSize="xs" fontWeight="semibold" color="orange.500" textTransform="uppercase" letterSpacing="wide" mb={2}>
                Overdue Commitments
              </Text>
              <VStack align="stretch" spacing={1}>
                {briefing.overdueCommitments.map((c: any, idx: number) => (
                  <Flex key={idx} align="flex-start" gap={2} px={3} py={1.5}>
                    <WarningIcon color="orange.400" boxSize="12px" flexShrink={0} mt="3px" />
                    <Box>
                      <Text fontSize="sm">{c.who}: {c.text}</Text>
                      <Text fontSize="xs" color={mutedText}>
                        {c.daysOverdue} day{c.daysOverdue !== 1 ? 's' : ''} overdue — from "{c.meetingTitle}"
                      </Text>
                    </Box>
                  </Flex>
                ))}
              </VStack>
            </Box>
          )}
        </Box>
      )}

      <Flex gap={5} align="start">
        {/* ── LEFT PANEL ── */}
        <Box w="25%" minW="220px" flexShrink={0}>
          <Card p={4} mb={4}>
            <Flex justify="space-between" align="center" mb={3}>
              <IconButton aria-label="Previous month" icon={<ChevronLeftIcon />} size="xs" variant="ghost" onClick={prevMonth} />
              <Text fontSize="sm" fontWeight="semibold">{MONTH_NAMES[calMonthIndex]} {calYear}</Text>
              <IconButton aria-label="Next month" icon={<ChevronRightIcon />} size="xs" variant="ghost" onClick={nextMonth} />
            </Flex>
            <Grid templateColumns="repeat(7, 1fr)" mb={1}>
              {DAY_LABELS.map(d => (
                <Box key={d} textAlign="center">
                  <Text fontSize="10px" color={mutedText} fontWeight="semibold">{d}</Text>
                </Box>
              ))}
            </Grid>
            <Grid templateColumns="repeat(7, 1fr)" gap={0}>
              {Array.from({ length: firstDow }).map((_, i) => <Box key={`e-${i}`} />)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1;
                const cellDate = new Date(calYear, calMonthIndex, day);
                const isToday = isSameDay(cellDate, new Date());
                const isSelected = isSameDay(cellDate, selectedDate);
                const hasMeeting = meetingDateStrings.has(cellDate.toDateString());
                return (
                  <Box key={day} textAlign="center" py={1} cursor="pointer" onClick={() => setSelectedDate(cellDate)}
                    borderRadius="md" bg={isToday ? todayBg : isSelected ? selectedBg : 'transparent'}
                    _hover={{ bg: isToday ? todayBg : hoverBg }} transition="background 0.1s" position="relative">
                    <Text fontSize="sm" fontWeight={isToday || isSelected ? 'bold' : 'normal'}
                      color={isToday ? 'white' : isSelected ? 'brand.500' : undefined} lineHeight="1.6">
                      {day}
                    </Text>
                    {hasMeeting && (
                      <Box position="absolute" bottom="2px" left="50%" transform="translateX(-50%)"
                        w="4px" h="4px" borderRadius="full" bg={isToday ? 'white' : 'brand.400'} />
                    )}
                  </Box>
                );
              })}
            </Grid>
          </Card>

          <Card p={4}>
            <Text fontSize="xs" fontWeight="semibold" color={sectionHeading} textTransform="uppercase" letterSpacing="wide" mb={3}>
              Integrations
            </Text>
            <Flex gap={2} flexWrap="wrap">
              <Tooltip label="Email integration coming soon">
                <Badge display="flex" alignItems="center" gap={1} px={3} py={1.5} borderRadius="full" colorScheme="gray" variant="subtle" cursor="default" fontSize="xs">
                  <Icon as={FiMail} boxSize={3} /> Email
                </Badge>
              </Tooltip>
              <Tooltip label="Chat integration coming soon">
                <Badge display="flex" alignItems="center" gap={1} px={3} py={1.5} borderRadius="full" colorScheme="gray" variant="subtle" cursor="default" fontSize="xs">
                  <Icon as={FiMessageSquare} boxSize={3} /> Chat
                </Badge>
              </Tooltip>
              <Tooltip label="Desktop recording enabled">
                <Badge display="flex" alignItems="center" gap={1} px={3} py={1.5} borderRadius="full"
                  colorScheme="green" variant="subtle" cursor="default" fontSize="xs">
                  <Icon as={FiVideo} boxSize={3} /> Meeting
                </Badge>
              </Tooltip>
              <Tooltip label={calendarConnected ? 'ICS calendar connected' : 'Add ICS URL in Settings -> Calendar'}>
                <Badge display="flex" alignItems="center" gap={1} px={3} py={1.5} borderRadius="full"
                  colorScheme={calendarConnected ? 'green' : 'gray'} variant="subtle" cursor="default" fontSize="xs">
                  <Icon as={FiCalendar} boxSize={3} /> Calendar
                </Badge>
              </Tooltip>
            </Flex>
          </Card>
        </Box>

        {/* ── RIGHT PANEL ── */}
        <Box flex={1} minW={0}>
          <Card p={5}>
            <Flex justify="space-between" align="center" mb={4}>
              <Box>
                <Text fontSize="md" fontWeight="bold">{formatSelectedDate(selectedDate)}</Text>
                <Text fontSize="xs" color={mutedText} mt={0.5}>
                  {dayMeetings.length === 0 ? 'No meetings' : `${dayMeetings.length} meeting${dayMeetings.length !== 1 ? 's' : ''}`}
                </Text>
              </Box>
            </Flex>

            {dayMeetings.length === 0 ? (
              <VStack py={10} spacing={3}>
                <Text color="gray.400" fontSize="sm">No meetings on this day</Text>
                {!calendarConnected && (
                  <Text fontSize="xs" color="gray.400" textAlign="center">
                    Connect a calendar in Settings to see upcoming meetings
                  </Text>
                )}
                <Button size="sm" leftIcon={<AddIcon />} variant="outline" onClick={onUploadOpen}>
                  Upload transcript
                </Button>
              </VStack>
            ) : (
              <VStack align="stretch" spacing={5}>
                {upcomingMeetings.length > 0 && (
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" color={sectionHeading} textTransform="uppercase" letterSpacing="wide" mb={2}>
                      Upcoming
                    </Text>
                    <VStack align="stretch" spacing={2}>
                      {upcomingMeetings.map(m => renderUpcomingCard(m))}
                    </VStack>
                  </Box>
                )}
                {upcomingMeetings.length > 0 && completedMeetings.length > 0 && <Divider />}
                {completedMeetings.length > 0 && (
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" color={sectionHeading} textTransform="uppercase" letterSpacing="wide" mb={2}>
                      Completed
                    </Text>
                    <VStack align="stretch" spacing={2}>
                      {completedMeetings.map(m => renderCompletedCard(m))}
                    </VStack>
                  </Box>
                )}
              </VStack>
            )}
          </Card>
        </Box>
      </Flex>

      <AlertDialog isOpen={isDeleteOpen} leastDestructiveRef={deleteRef} onClose={onDeleteClose}>
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader fontSize="lg" fontWeight="bold">Delete Meeting</AlertDialogHeader>
            <AlertDialogBody>This will permanently delete the meeting and its linked tasks.</AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={deleteRef} onClick={onDeleteClose}>Cancel</Button>
              <Button colorScheme="red" onClick={handleDeleteConfirm} ml={3} isLoading={isDeleting}>Delete</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>

      <TranscriptUploadModal isOpen={isUploadOpen} onClose={onUploadClose} onUpload={handleUploadTranscript} />

      {reviewMeetingData && (
        <TranscriptReviewModal
          isOpen={isReviewOpen}
          onClose={onReviewClose}
          meetingId={reviewMeetingData?._id ?? null}
          onApproved={handleReviewApproved}
        />
      )}

      {jiraMappingMeeting && (
        <JiraMappingModal
          isOpen={!!jiraMappingMeeting}
          onClose={() => setJiraMappingMeeting(null)}
          actionItems={jiraMappingMeeting.actionItems}
          meetingTitle={jiraMappingMeeting.title}
          meetingId={jiraMappingMeeting.id}
          onComplete={fetchMeetings}
        />
      )}

      {/* Jira Sync Details Modal */}
      <Modal isOpen={isJiraSyncOpen} onClose={onJiraSyncClose} motionPreset="scale" size="lg">
        <FlowModalOverlay />
        <FlowModalContent>
          <FlowModalHeader title="Jira Sync Summary" />
          <FlowModalBody>
            {jiraSyncDetails && (
              <VStack align="stretch" spacing={3}>
                {jiraSyncDetails.created > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="green.50" borderWidth="1px" borderColor="green.200">
                    <HStack spacing={2}><Badge colorScheme="green" fontSize="xs">NEW</Badge><Text fontSize="sm" fontWeight="600">{jiraSyncDetails.created} task{jiraSyncDetails.created !== 1 ? 's' : ''} pushed to Jira</Text></HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>New Jira issues created from meeting action items</Text>
                  </Box>
                )}
                {jiraSyncDetails.linked > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="blue.50" borderWidth="1px" borderColor="blue.200">
                    <HStack spacing={2}><Badge colorScheme="blue" fontSize="xs">LINKED</Badge><Text fontSize="sm" fontWeight="600">{jiraSyncDetails.linked} task{jiraSyncDetails.linked !== 1 ? 's' : ''} linked to existing stories</Text></HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>Matched to existing Jira stories with high confidence</Text>
                  </Box>
                )}
                {jiraSyncDetails.updated > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="brand.50" borderWidth="1px" borderColor="brand.200">
                    <HStack spacing={2}><Badge colorScheme="brand" fontSize="xs">UPDATED</Badge><Text fontSize="sm" fontWeight="600">{jiraSyncDetails.updated} task{jiraSyncDetails.updated !== 1 ? 's' : ''} synced to Jira</Text></HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>Status and field changes pushed to Jira</Text>
                  </Box>
                )}
                {jiraSyncDetails.pulled > 0 && (
                  <Box px={4} py={3} borderRadius="8px" bg="purple.50" borderWidth="1px" borderColor="purple.200">
                    <HStack spacing={2}><Badge colorScheme="purple" fontSize="xs">PULLED</Badge><Text fontSize="sm" fontWeight="600">{jiraSyncDetails.pulled} update{jiraSyncDetails.pulled !== 1 ? 's' : ''} from Jira</Text></HStack>
                    <Text fontSize="xs" color="gray.500" mt={1}>Jira issue changes synced to your local tasks</Text>
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
