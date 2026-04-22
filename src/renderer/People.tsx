/**
 * People View
 *
 * Shows all historic communication per person across integrated channels.
 * Person profile -> all communications -> summary, next steps, relationship metrics.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Flex, Text, SimpleGrid, Avatar, VStack, HStack, Badge, Progress,
  useColorModeValue, Spinner, Button, Input, InputGroup, InputLeftElement,
  Stat, StatLabel, StatNumber, Drawer, DrawerOverlay, DrawerContent,
  DrawerHeader, DrawerBody, DrawerCloseButton, useDisclosure, Menu,
  MenuButton, MenuList, MenuItem, Divider, Tag, TagLabel, Modal,
  ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter,
  ModalCloseButton, Checkbox, useToast, Icon, IconButton, Collapse,
  FormControl, FormLabel, Textarea
} from '@chakra-ui/react';
import {
  SearchIcon, CalendarIcon, StarIcon, ChevronDownIcon, ChevronUpIcon,
  AddIcon, EmailIcon
} from '@chakra-ui/icons';
import {
  MdWork, MdBusiness, MdVideocam, MdChat, MdAutoAwesome, MdAccessTime,
  MdPerson, MdArchive, MdUnarchive, MdMoreVert, MdRefresh, MdOutlineEventNote, MdWarning
} from 'react-icons/md';
import Card from './components/card/Card';
import {
  FlowModalOverlay, FlowModalContent, FlowModalHeader, FlowModalBody, FlowModalFooter,
  FlowFormLabel, INPUT_PROPS, TEXTAREA_PROPS
} from './components/modal/FlowModalShell';
import { api } from './api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Person {
  _id: string;
  name: string;
  email: string | null;
  company: string | null;
  role: string | null;
  meetingCount: number;
  lastMeeting: string;
  firstMeeting: string;
  actionItemCount: number;
  daysSinceLastContact: number | null;
  relationshipDuration: number;
  engagementScore: number;
  recentMeetings: Array<{ _id: string; title: string; date: string }>;
  trackedBy?: boolean;
}

interface SuggestedPerson {
  name: string;
  meetingCount: number;
  recentMeetings: Array<{ _id: string; title: string; date: string }>;
}

interface ActionItem {
  text: string;
  assignee: string;
  dueDate: string;
  convertedToTaskId: string | null;
  taskStatus: string | null;
  insightId: string;
  actionItemIndex: number;
  meetingId: string;
  meetingTitle?: string;
  isCommitment?: boolean;
}

interface Communication {
  _id: string;
  title: string;
  date: string;
  channel: 'meeting' | 'email' | 'slack';
  summary: string | null;
  actionItems: ActionItem[];
  keyDecisions: string[];
}

interface Nudge {
  type: 'overdue_commitment' | 'stale_task';
  severity: 'high' | 'medium';
  text: string;
  meetingTitle?: string;
  meetingDate?: string;
}

interface PersonDetail {
  _id: string;
  name: string;
  email: string | null;
  company: string | null;
  role: string | null;
  bio: string | null;
  relationshipInsights: string[];
  summary: {
    totalMeetings: number;
    totalActionItems: number;
    pendingActionItems: number;
    totalDecisions: number;
    keyTopics: string[];
    firstInteraction: string;
    lastInteraction: string;
    daysSinceLastContact: number | null;
  };
  pendingActionItems: ActionItem[];
  communications: Communication[];
  workingGroups: Array<{ name: string; meetingsTogether: number }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function taskStatusLabel(status: string | null): string {
  if (status === 'todo') return 'To Do';
  if (status === 'inProgress') return 'In Progress';
  return '';
}

function formatLastContact(days: number | null | undefined): { label: string; value: string } {
  if (days === null || days === undefined) return { label: 'Last Contact', value: '—' };
  if (days < 0) return { label: 'Next Meeting', value: `in ${Math.abs(days)}d` };
  if (days === 0) return { label: 'Last Contact', value: 'Today' };
  return { label: 'Days Ago', value: String(days) };
}

function ChannelIcon({ channel }: { channel: string }) {
  if (channel === 'email') return <Icon as={EmailIcon} boxSize={4} color="gray.400" />;
  if (channel === 'slack') return <Icon as={MdChat} boxSize={4} color="gray.400" />;
  return <Icon as={MdVideocam} boxSize={4} color="gray.400" />;
}

// ─── Nudge computation ──────────────────────────────────────────────────────

function computeNudges(actionItems: ActionItem[]): Nudge[] {
  const now = new Date();
  const nudges: Nudge[] = [];

  (actionItems || []).forEach(item => {
    // Overdue commitment nudge — only for isCommitment items
    if (item.isCommitment && item.dueDate) {
      const due = new Date(item.dueDate);
      const daysOverdue = Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
      if (daysOverdue > 0) {
        nudges.push({
          type: 'overdue_commitment',
          severity: daysOverdue > 7 ? 'high' : 'medium',
          text: `Committed to '${item.text}' — ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue`,
          meetingTitle: item.meetingTitle,
          meetingDate: item.dueDate
        });
      }
    }
  });

  (actionItems || []).forEach(item => {
    if (item.convertedToTaskId && item.taskStatus === 'todo' && item.dueDate) {
      const due = new Date(item.dueDate);
      const daysOpen = Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
      if (daysOpen > 0) {
        const alreadyHasOverdue = nudges.some(n => n.type === 'overdue_commitment' && n.text.includes(item.text));
        if (!alreadyHasOverdue) {
          nudges.push({
            type: 'stale_task',
            severity: daysOpen > 14 ? 'high' : 'medium',
            text: `'${item.text}' has been open for ${daysOpen} days`,
            meetingTitle: item.meetingTitle,
            meetingDate: item.dueDate
          });
        }
      }
    }
  });

  nudges.sort((a, b) => (a.severity === 'high' && b.severity !== 'high' ? -1 : a.severity !== 'high' && b.severity === 'high' ? 1 : 0));

  return nudges;
}

// ─── Action Item Row ──────────────────────────────────────────────────────────

function ActionItemRow({
  item,
  onCreateTask
}: {
  item: ActionItem;
  onCreateTask: (item: ActionItem) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const borderColor = useColorModeValue('gray.200', 'gray.600');
  const bg = useColorModeValue('white', 'gray.750');

  const handleCreate = async () => {
    setCreating(true);
    try {
      await onCreateTask(item);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Box border="1px solid" borderColor={borderColor} borderRadius="lg" p={3} bg={bg}>
      <Flex justify="space-between" align="flex-start" gap={2}>
        <HStack spacing={2} flex={1}>
          <Text fontWeight="semibold" fontSize="sm">{item.text}</Text>
          {item.isCommitment && <Badge colorScheme="purple" variant="subtle" borderRadius="full" px={2} fontSize="xs">Commitment</Badge>}
        </HStack>
        {item.convertedToTaskId && item.taskStatus ? (
          <Badge variant="outline" colorScheme="gray" borderRadius="full" fontSize="xs" px={2} py={1} whiteSpace="nowrap">
            ⊙ {taskStatusLabel(item.taskStatus)}
          </Badge>
        ) : (
          <IconButton
            aria-label="Create task"
            icon={<AddIcon />}
            size="xs"
            variant="ghost"
            borderRadius="full"
            border="1px solid"
            borderColor={borderColor}
            isLoading={creating}
            onClick={handleCreate}
          />
        )}
      </Flex>
      <HStack spacing={3} mt={1.5}>
        <HStack spacing={1}>
          <Icon as={MdPerson} boxSize={3} color="gray.400" />
          <Text fontSize="xs" color="gray.500">{item.assignee}</Text>
        </HStack>
        <HStack spacing={1}>
          <Icon as={CalendarIcon} boxSize={3} color="gray.400" />
          <Text fontSize="xs" color="gray.500">Due {formatDate(item.dueDate)}</Text>
        </HStack>
      </HStack>
    </Box>
  );
}

// ─── Communication Row ────────────────────────────────────────────────────────

function CommunicationRow({
  comm,
  onCreateTask
}: {
  comm: Communication;
  onCreateTask: (item: ActionItem) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const borderColor = useColorModeValue('gray.200', 'gray.600');
  const summaryColor = useColorModeValue('teal.600', 'teal.300');
  const hoverBg = useColorModeValue('gray.50', 'gray.700');

  const hasContent = comm.summary || (comm.actionItems?.length ?? 0) > 0 || (comm.keyDecisions?.length ?? 0) > 0;

  return (
    <Box border="1px solid" borderColor={borderColor} borderRadius="lg" overflow="hidden">
      <Flex
        px={3} py={2.5} align="center" justify="space-between"
        cursor={hasContent ? 'pointer' : 'default'}
        onClick={() => hasContent && setExpanded(e => !e)}
        _hover={hasContent ? { bg: hoverBg } : undefined}
      >
        <HStack spacing={2} flex={1} minW={0}>
          <ChannelIcon channel={comm.channel} />
          <Text fontSize="sm" fontWeight="medium" noOfLines={1}>{comm.title}</Text>
        </HStack>
        <HStack spacing={2} flexShrink={0}>
          <Text fontSize="xs" color="gray.500">{formatDate(comm.date)}</Text>
          {hasContent && <Icon as={expanded ? ChevronUpIcon : ChevronDownIcon} boxSize={4} color="gray.400" />}
        </HStack>
      </Flex>

      <Collapse in={expanded} animateOpacity>
        <Box px={3} pb={3} borderTop="1px solid" borderColor={borderColor}>
          {comm.summary && (
            <Text fontSize="sm" color={summaryColor} mt={2} mb={3} lineHeight="tall">{comm.summary}</Text>
          )}

          {(comm.actionItems?.length ?? 0) > 0 && (
            <Box mb={3}>
              <Text fontSize="xs" fontWeight="bold" mb={2}>Action Items</Text>
              <VStack spacing={2} align="stretch">
                {comm.actionItems.map((item, idx) => (
                  <ActionItemRow key={idx} item={item} onCreateTask={onCreateTask} />
                ))}
              </VStack>
            </Box>
          )}

          {(comm.keyDecisions?.length ?? 0) > 0 && (
            <Box>
              <Text fontSize="xs" fontWeight="bold" mb={2}>Key Decisions</Text>
              <VStack spacing={1} align="stretch">
                {comm.keyDecisions.map((decision, idx) => (
                  <HStack key={idx} spacing={2} align="flex-start">
                    <Text fontSize="sm" color="gray.500" mt={0.5}>✓</Text>
                    <Text fontSize="sm" color={summaryColor}>{decision}</Text>
                  </HStack>
                ))}
              </VStack>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

// ─── Person Detail Drawer ─────────────────────────────────────────────────────

function PersonDetailDrawer({
  isOpen,
  onClose,
  personId,
  personName
}: {
  isOpen: boolean;
  onClose: () => void;
  personId: string | null;
  personName: string | null;
}) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatingInsights, setGeneratingInsights] = useState(false);
  const [commExpanded, setCommExpanded] = useState(false);
  const [agenda, setAgenda] = useState<string[] | null>(null);
  const [generatingAgenda, setGeneratingAgenda] = useState(false);
  const toast = useToast();

  const bgColor = useColorModeValue('white', 'gray.800');
  const sectionLabelColor = useColorModeValue('gray.500', 'gray.400');
  const bioColor = useColorModeValue('teal.600', 'teal.300');
  const borderColor = useColorModeValue('gray.200', 'gray.600');

  useEffect(() => {
    if (isOpen && personId) {
      setLoading(true);
      setAgenda(null);
      api.getPerson(personId)
        .then((data: any) => { if (data) setPerson(data); })
        .catch(() => toast({ title: 'Failed to load person', status: 'error', duration: 3000 }))
        .finally(() => setLoading(false));
    }
  }, [isOpen, personId]);

  const handleGenerateInsights = async () => {
    if (!personId) return;
    setGeneratingInsights(true);
    try {
      const data = await api.generatePersonInsights(personId);
      if (data.bio || data.relationshipInsights) {
        setPerson(prev => prev ? {
          ...prev,
          bio: data.bio ?? prev.bio,
          relationshipInsights: data.relationshipInsights ?? prev.relationshipInsights
        } : prev);
        toast({ title: 'Insights generated', status: 'success', duration: 2000 });
      } else {
        toast({ title: 'Inwise is still learning about this person. After a few meetings, insights will appear automatically.', status: 'info', duration: 4000 });
      }
    } catch {
      toast({ title: 'Failed to generate insights', status: 'error', duration: 3000 });
    } finally {
      setGeneratingInsights(false);
    }
  };

  // Only count meetings that have actual insights (not just calendar-synced shells)
  const hasSharedMeetingsWithContent = (person?.communications ?? []).some(
    (c: any) => c.summary || (c.actionItems && c.actionItems.length > 0) || (c.keyDecisions && c.keyDecisions.length > 0)
  );

  const handleGenerateAgenda = async () => {
    if (!personId) return;
    if (!hasSharedMeetingsWithContent) {
      toast({ title: 'Inwise is still learning about this person. Record and process a meeting together for personalized agenda suggestions.', status: 'info', duration: 4000 });
      return;
    }
    setGeneratingAgenda(true);
    try {
      const data = await api.generateAgenda(personId);
      if (data.agenda?.length) {
        setAgenda(data.agenda);
      } else {
        toast({ title: 'Inwise is still learning about this person. After a few meetings, agenda suggestions will appear automatically.', status: 'info', duration: 4000 });
      }
    } catch {
      toast({ title: 'Failed to generate agenda', status: 'error', duration: 3000 });
    } finally {
      setGeneratingAgenda(false);
    }
  };

  const handleCreateTask = useCallback(async (item: ActionItem) => {
    if (!person) return;
    try {
      await api.createTask({
        title: item.text,
        dueDate: item.dueDate,
        status: 'todo',
        priority: 'medium',
      });
      toast({ title: 'Task created', status: 'success', duration: 2000 });
    } catch {
      toast({ title: 'Failed to create task', status: 'error', duration: 3000 });
    }
  }, [person, toast]);

  const initials = person?.name
    ? person.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : '';

  return (
    <Drawer isOpen={isOpen} onClose={onClose} size="md" placement="right">
      <DrawerOverlay />
      <DrawerContent bg={bgColor} maxW="480px">
        <DrawerCloseButton />
        <DrawerBody px={6} py={5}>
          {loading ? (
            <Flex justify="center" align="center" h="full"><Spinner size="lg" /></Flex>
          ) : !person ? (
            <Flex justify="center" align="center" h="full"><Text color="gray.500">Person not found</Text></Flex>
          ) : (
            <VStack align="stretch" spacing={5}>

              {/* Header */}
              <HStack spacing={4} pt={2}>
                <Avatar size="lg" name={person.name} bg="gray.300" color="gray.700" getInitials={() => initials} />
                <VStack align="start" spacing={0}>
                  <Text fontSize="xl" fontWeight="bold">{person.name}</Text>
                  {person.role && <Text fontSize="sm" color="blue.500">{person.role}</Text>}
                </VStack>
              </HStack>

              {/* Profile */}
              <Box>
                <Text fontSize="xs" fontWeight="bold" color={sectionLabelColor} letterSpacing="wider" textTransform="uppercase" mb={2}>
                  Profile
                </Text>
                <VStack align="start" spacing={1.5}>
                  {person.company && (
                    <HStack spacing={2}><Icon as={MdBusiness} boxSize={4} color="gray.400" /><Text fontSize="sm">{person.company}</Text></HStack>
                  )}
                  {person.role && (
                    <HStack spacing={2}><Icon as={MdWork} boxSize={4} color="gray.400" /><Text fontSize="sm">{person.role}</Text></HStack>
                  )}
                  {person.bio ? (
                    <Text fontSize="sm" color={bioColor} mt={1}>{person.bio}</Text>
                  ) : (
                    <Button size="xs" variant="ghost" leftIcon={<Icon as={MdAutoAwesome} />} colorScheme="teal"
                      isLoading={generatingInsights} onClick={handleGenerateInsights} mt={1}>
                      Generate AI insights
                    </Button>
                  )}
                </VStack>
              </Box>

              {/* Relationship Insights */}
              {((person.relationshipInsights?.length ?? 0) > 0 || person.bio) && (
                <>
                  <Divider />
                  <Box>
                    <HStack mb={2} spacing={1}>
                      <Icon as={MdAutoAwesome} boxSize={3.5} color={sectionLabelColor} />
                      <Text fontSize="xs" fontWeight="bold" color={sectionLabelColor} letterSpacing="wider" textTransform="uppercase">
                        Relationship Insights
                      </Text>
                    </HStack>
                    {(person.relationshipInsights?.length ?? 0) > 0 ? (
                      <Flex wrap="wrap" gap={2}>
                        {person.relationshipInsights.map((insight, idx) => (
                          <Tag key={idx} size="md" borderRadius="full" variant="outline" colorScheme="gray">
                            <TagLabel fontSize="xs">{insight}</TagLabel>
                          </Tag>
                        ))}
                      </Flex>
                    ) : (
                      <Button size="xs" variant="ghost" leftIcon={<Icon as={MdAutoAwesome} />} colorScheme="teal"
                        isLoading={generatingInsights} onClick={handleGenerateInsights}>
                        Generate relationship insights
                      </Button>
                    )}
                  </Box>
                </>
              )}

              <Divider />

              {/* Suggested Agenda */}
              <Box>
                <HStack mb={3} spacing={1}>
                  <Icon as={MdOutlineEventNote} boxSize={3.5} color={sectionLabelColor} />
                  <Text fontSize="xs" fontWeight="bold" color={sectionLabelColor} letterSpacing="wider" textTransform="uppercase">
                    Suggested Agenda
                  </Text>
                </HStack>

                {!hasSharedMeetingsWithContent ? (
                  <Box px={3} py={2} borderRadius="8px" border="1px solid" borderColor="gray.200" bg="gray.50">
                    <Text fontSize="12px" color="gray.500">Inwise is still learning about this person. Record and process a meeting together for personalized agenda suggestions.</Text>
                  </Box>
                ) : generatingAgenda ? (
                  <Flex align="center" gap={2}><Spinner size="xs" /><Text fontSize="sm" color="gray.400">Generating agenda…</Text></Flex>
                ) : agenda && agenda.length > 0 ? (
                  <VStack align="stretch" spacing={2}>
                    <VStack align="stretch" spacing={1}>
                      {agenda.map((item, idx) => (
                        <HStack key={idx} spacing={2} align="flex-start">
                          <Text fontSize="sm" color={sectionLabelColor} mt={0.5}>•</Text>
                          <Text fontSize="sm">{item}</Text>
                        </HStack>
                      ))}
                    </VStack>
                    <Button size="xs" variant="ghost" leftIcon={<Icon as={MdAutoAwesome} />} colorScheme="teal"
                      isLoading={generatingAgenda} onClick={handleGenerateAgenda} alignSelf="flex-start">
                      Regenerate Suggested Agenda
                    </Button>
                  </VStack>
                ) : (
                  <Button size="xs" variant="ghost" leftIcon={<Icon as={MdAutoAwesome} />} colorScheme="teal"
                    isLoading={generatingAgenda} onClick={handleGenerateAgenda}>
                    Generate Suggested Agenda
                  </Button>
                )}
              </Box>

              {/* Needs Attention Nudges */}
              {(() => {
                const nudges = computeNudges(person.pendingActionItems ?? []);
                return (
                  <>
                    {nudges.length > 0 && (
                      <>
                        <Divider />
                        <Box>
                          <Box bg="orange.50" border="1px solid" borderColor="orange.200" borderRadius="lg" p={4}>
                            <HStack mb={3} spacing={2}>
                              <Icon as={MdWarning} boxSize={4} color="orange.500" />
                              <Text fontSize="xs" fontWeight="bold" color="orange.700" letterSpacing="wider" textTransform="uppercase">
                                Needs Attention ({nudges.length})
                              </Text>
                            </HStack>
                            <VStack spacing={2} align="stretch">
                              {nudges.map((nudge, idx) => (
                                <HStack key={idx} spacing={2} align="flex-start">
                                  <Box w="8px" h="8px" borderRadius="full" bg={nudge.severity === 'high' ? 'red.500' : 'orange.400'} mt={1.5} flexShrink={0} />
                                  <Box flex={1}>
                                    <Text fontSize="sm" fontWeight="medium">{nudge.text}</Text>
                                    {nudge.meetingTitle && (
                                      <Text fontSize="xs" color="gray.500" mt={0.5}>From: {nudge.meetingTitle}</Text>
                                    )}
                                  </Box>
                                </HStack>
                              ))}
                            </VStack>
                          </Box>
                        </Box>
                      </>
                    )}
                  </>
                );
              })()}

              <Divider />

              {/* Pending Action Items */}
              <Box>
                <HStack mb={3} spacing={1}>
                  <Icon as={MdAccessTime} boxSize={3.5} color={sectionLabelColor} />
                  <Text fontSize="xs" fontWeight="bold" color={sectionLabelColor} letterSpacing="wider" textTransform="uppercase">
                    Pending Action Items
                  </Text>
                </HStack>
                {(person.pendingActionItems?.length ?? 0) === 0 ? (
                  <Text fontSize="sm" color="gray.400">No pending action items</Text>
                ) : (
                  <VStack spacing={2} align="stretch">
                    {(person.pendingActionItems ?? []).map((item, idx) => (
                      <ActionItemRow key={idx} item={item} onCreateTask={handleCreateTask} />
                    ))}
                  </VStack>
                )}
              </Box>

              <Divider />

              {/* Communications */}
              <Box>
                <Flex justify="space-between" align="center" cursor="pointer"
                  onClick={() => setCommExpanded(e => !e)} mb={commExpanded ? 3 : 0}>
                  <HStack spacing={1}>
                    <Icon as={CalendarIcon} boxSize={3.5} color={sectionLabelColor} />
                    <Text fontSize="xs" fontWeight="bold" color={sectionLabelColor} letterSpacing="wider" textTransform="uppercase">
                      Communications ({person.communications?.length ?? 0})
                    </Text>
                  </HStack>
                  <Icon as={commExpanded ? ChevronUpIcon : ChevronDownIcon} boxSize={4} color={sectionLabelColor} />
                </Flex>

                <Collapse in={commExpanded} animateOpacity>
                  <VStack spacing={2} align="stretch">
                    {(person.communications ?? []).map(comm => (
                      <CommunicationRow key={comm._id} comm={comm} onCreateTask={handleCreateTask} />
                    ))}
                  </VStack>
                </Collapse>
              </Box>

            </VStack>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

// ─── Add Person Modal ─────────────────────────────────────────────────────────

function AddPersonModal({
  isOpen,
  onClose,
  onAdded
}: {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (personName: string) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const reset = () => { setFirstName(''); setLastName(''); setEmail(''); setNotes(''); };
  const handleClose = () => { reset(); onClose(); };

  const handleAdd = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast({ title: 'First and last name are required', status: 'warning', duration: 3000 });
      return;
    }
    setSaving(true);
    try {
      const data = await api.addPerson({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || null,
        notes: notes.trim() || null,
      });
      const personName = data.name;
      const retroCount = data.retroactiveMeetingCount;
      toast({
        title: `${personName} added`,
        description: retroCount > 0
          ? `Found ${retroCount} existing meeting${retroCount !== 1 ? 's' : ''} in the last 90 days`
          : "No existing meetings found",
        status: 'success',
        duration: 4000
      });
      onAdded(personName);
      handleClose();
    } catch (err: any) {
      toast({ title: err.message || 'Failed to add person', status: 'error', duration: 3000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" motionPreset="scale">
      <FlowModalOverlay />
      <FlowModalContent>
        <FlowModalHeader title="Add Person" subtitle="Add a new contact to your people list" />
        <FlowModalBody>
          <VStack spacing={4}>
            <SimpleGrid columns={2} spacing={3} w="full">
              <FormControl>
                <FlowFormLabel>First Name</FlowFormLabel>
                <Input placeholder="Jane" value={firstName} onChange={e => setFirstName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} {...INPUT_PROPS} />
              </FormControl>
              <FormControl>
                <FlowFormLabel>Last Name</FlowFormLabel>
                <Input placeholder="Doe" value={lastName} onChange={e => setLastName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} {...INPUT_PROPS} />
              </FormControl>
            </SimpleGrid>

            <FormControl>
              <FlowFormLabel>Email</FlowFormLabel>
              <Input placeholder="jane@example.com" type="email" value={email} onChange={e => setEmail(e.target.value)} {...INPUT_PROPS} />
            </FormControl>

            <FormControl>
              <FlowFormLabel>Notes</FlowFormLabel>
              <Textarea placeholder="Any notes about this person..." value={notes} onChange={e => setNotes(e.target.value)} rows={3} {...TEXTAREA_PROPS} />
            </FormControl>
          </VStack>
        </FlowModalBody>
        <FlowModalFooter
          onCancel={handleClose}
          onConfirm={handleAdd}
          confirmLabel="Add Person"
          isLoading={saving}
          isDisabled={!firstName.trim() || !lastName.trim()}
        />
      </FlowModalContent>
    </Modal>
  );
}

// ─── Suggested People Modal ───────────────────────────────────────────────────

function SuggestedPersonTile({
  person,
  checked,
  onToggle
}: {
  person: SuggestedPerson;
  checked: boolean;
  onToggle: () => void;
}) {
  const bg = useColorModeValue('white', 'gray.700');
  const borderColor = useColorModeValue(checked ? 'brand.500' : 'gray.200', checked ? 'brand.400' : 'gray.600');

  return (
    <Box p={4} bg={bg} borderWidth="2px" borderColor={borderColor} borderRadius="xl" cursor="pointer"
      onClick={onToggle} transition="all 0.15s" _hover={{ boxShadow: 'md' }}>
      <HStack spacing={3} align="start" w="full" minW={0}>
        <Checkbox isChecked={checked} onChange={onToggle} onClick={e => e.stopPropagation()} colorScheme="brand" mt={1} flexShrink={0} />
        <VStack align="start" spacing={1} flex={1} minW={0} w="full">
          <HStack justify="space-between" w="full" spacing={2}>
            <Avatar size="sm" name={person.name} flexShrink={0} />
            <Badge colorScheme="purple" fontSize="xs" flexShrink={0} whiteSpace="nowrap">
              {person.meetingCount} meetings / 7d
            </Badge>
          </HStack>
          <Text fontWeight="semibold" fontSize="sm" noOfLines={1} w="full" title={person.name}>{person.name}</Text>
          {person.recentMeetings.length > 0 && (
            <Text fontSize="xs" color="gray.500" noOfLines={1} w="full" title={person.recentMeetings[person.recentMeetings.length - 1]?.title}>
              Last: {person.recentMeetings[person.recentMeetings.length - 1]?.title}
            </Text>
          )}
        </VStack>
      </HStack>
    </Box>
  );
}

function SuggestedPeopleModal({
  isOpen,
  onClose,
  onAdded
}: {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (names: string[]) => void;
}) {
  const [suggested, setSuggested] = useState<SuggestedPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toast = useToast();
  const emptyBg = useColorModeValue('gray.50', 'gray.700');

  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set());
    setLoading(true);
    api.getSuggestedPeople()
      .then((data: any) => setSuggested(data?.suggestedPeople || data || []))
      .catch(() => toast({ title: 'Failed to load suggestions', status: 'error', duration: 3000 }))
      .finally(() => setLoading(false));
  }, [isOpen]);

  const togglePerson = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const handleAdd = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const names = Array.from(selected);
      await api.addTrackedPeople(names);
      toast({ title: `Added ${names.length} ${names.length === 1 ? 'person' : 'people'}`, status: 'success', duration: 2500 });
      onAdded(names);
      onClose();
    } catch {
      toast({ title: 'Failed to add people', status: 'error', duration: 3000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" scrollBehavior="inside" motionPreset="scale">
      <FlowModalOverlay />
      <FlowModalContent>
        <FlowModalHeader title="AI Suggested People" subtitle="People you've met most frequently in the last 7 days" />
        <FlowModalBody>
          {loading ? (
            <Flex justify="center" py={10}><Spinner size="lg" /></Flex>
          ) : suggested.length === 0 ? (
            <Box p={8} textAlign="center" bg={emptyBg} borderRadius="xl">
              <Text color="gray.500" fontSize="sm">No suggestions yet — check back after more meetings this week.</Text>
            </Box>
          ) : (
            <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={5} p={2}>
              {suggested.map(person => (
                <SuggestedPersonTile key={person.name} person={person} checked={selected.has(person.name)} onToggle={() => togglePerson(person.name)} />
              ))}
            </SimpleGrid>
          )}
        </FlowModalBody>
        <FlowModalFooter
          onCancel={onClose}
          onConfirm={handleAdd}
          confirmLabel="Add to People"
          isLoading={saving}
          isDisabled={selected.size === 0}
          extra={
            selected.size > 0 ? <Text fontSize="sm" color="gray.500">{selected.size} selected</Text> : undefined
          }
        />
      </FlowModalContent>
    </Modal>
  );
}

// ─── Person Card ──────────────────────────────────────────────────────────────

function PersonCard({
  person,
  isTracked,
  onClick,
  onArchive
}: {
  person: Person;
  isTracked: boolean;
  onClick: () => void;
  onArchive?: (personId: string) => void;
}) {
  const cardBg = useColorModeValue('white', 'gray.700');
  const borderColor = useColorModeValue(
    isTracked ? 'yellow.300' : 'gray.200',
    isTracked ? 'yellow.500' : 'gray.600'
  );

  const engagementColor = person.engagementScore >= 70 ? 'green' :
    person.engagementScore >= 40 ? 'yellow' : 'red';

  const contactStatus =
    person.daysSinceLastContact === null ? 'Unknown' :
      person.daysSinceLastContact < 7 ? 'Recent' :
        person.daysSinceLastContact < 30 ? 'Active' :
          person.daysSinceLastContact < 90 ? 'Stale' : 'Cold';

  const contactColor =
    contactStatus === 'Recent' ? 'green' :
      contactStatus === 'Active' ? 'blue' :
        contactStatus === 'Stale' ? 'orange' : 'red';

  return (
    <Card
      p={5} bg={cardBg} borderWidth="1px" borderColor={borderColor} borderRadius="xl" boxShadow="sm"
      _hover={{ boxShadow: 'lg', transform: 'translateY(-2px)' }}
      transition="all 0.2s" cursor="pointer" position="relative" onClick={onClick}
    >
      <Box position="absolute" top={2} right={2} onClick={e => e.stopPropagation()} zIndex={1}>
        <Menu>
          <MenuButton as={IconButton} icon={<Icon as={MdMoreVert} />} variant="ghost" size="xs" aria-label="Person options" />
          <MenuList minW="120px">
            <MenuItem icon={<Icon as={MdArchive} />} onClick={() => onArchive?.(person._id)} fontSize="sm">Archive</MenuItem>
          </MenuList>
        </Menu>
      </Box>

      <VStack align="stretch" spacing={3}>
        <HStack spacing={3}>
          <Box position="relative">
            <Avatar size="md" name={person.name} />
            {isTracked && <Icon as={StarIcon} color="yellow.400" boxSize={3} position="absolute" bottom={0} right={0} />}
          </Box>
          <VStack align="start" spacing={0} flex={1}>
            <Text fontWeight="bold" fontSize="md" noOfLines={1}>{person.name}</Text>
            {person.company && (
              <Text fontSize="xs" color="gray.500" noOfLines={1}>
                {person.role ? `${person.role} at ${person.company}` : person.company}
              </Text>
            )}
          </VStack>
          <Badge colorScheme={contactColor} fontSize="xs">{contactStatus}</Badge>
        </HStack>

        <SimpleGrid columns={3} spacing={2}>
          <Stat size="sm"><StatLabel fontSize="xs">Meetings</StatLabel><StatNumber fontSize="md">{person.meetingCount}</StatNumber></Stat>
          <Stat size="sm"><StatLabel fontSize="xs">Actions</StatLabel><StatNumber fontSize="md">{person.actionItemCount}</StatNumber></Stat>
          {(() => {
            const lc = formatLastContact(person.daysSinceLastContact);
            return (
              <Stat size="sm"><StatLabel fontSize="xs">{lc.label}</StatLabel><StatNumber fontSize="md">{lc.value}</StatNumber></Stat>
            );
          })()}
        </SimpleGrid>

        <Box>
          <HStack justify="space-between" mb={1}>
            <Text fontSize="xs" color="gray.500">Engagement</Text>
            <Text fontSize="xs" fontWeight="medium">{person.engagementScore}%</Text>
          </HStack>
          <Progress value={person.engagementScore} colorScheme={engagementColor} size="sm" borderRadius="full" />
        </Box>

        {person.recentMeetings && person.recentMeetings.length > 0 && (
          <Text fontSize="xs" color="gray.500" noOfLines={1}>
            Last: {person.recentMeetings[person.recentMeetings.length - 1]?.title}
          </Text>
        )}
      </VStack>
    </Card>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function PeopleDashboard() {
  const [people, setPeople] = useState<Person[]>([]);
  const [archivedPeople, setArchivedPeople] = useState<Person[]>([]);
  const [trackedPeople, setTrackedPeople] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPerson, setSelectedPerson] = useState<{ id: string; name: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const toast = useToast();
  const cardBg = useColorModeValue('white', 'gray.700');
  const borderColor = useColorModeValue('gray.200', 'gray.600');

  const { isOpen: isDrawerOpen, onOpen: onDrawerOpen, onClose: onDrawerClose } = useDisclosure();
  const { isOpen: isSuggestOpen, onOpen: onSuggestOpen, onClose: onSuggestClose } = useDisclosure();
  const { isOpen: isAddOpen, onOpen: onAddOpen, onClose: onAddClose } = useDisclosure();

  const fetchPeople = useCallback(async (search?: string) => {
    try {
      setLoading(true);
      const data = await api.getPeople(search);
      const validPeople = (data || []).filter((p: Person) => p.name);
      setPeople(validPeople);
      setTrackedPeople(new Set(validPeople.filter((p: Person) => p.trackedBy).map((p: Person) => p.name.toLowerCase())));
    } catch {
      setError('Failed to fetch people');
    } finally {
      setLoading(false);
    }

    try {
      const archived = await api.getArchivedPeople();
      setArchivedPeople(archived || []);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { fetchPeople(); }, [fetchPeople]);

  const handleArchivePerson = async (personId: string) => {
    const person = people.find(p => p._id === personId);
    if (!person) return;
    setPeople(prev => prev.filter(p => p._id !== personId));
    setArchivedPeople(prev => [...prev, person]);
    try {
      await api.archivePerson(personId);
      toast({ title: `${person.name} archived`, status: 'success', duration: 2000 });
    } catch {
      setPeople(prev => [...prev, person]);
      setArchivedPeople(prev => prev.filter(p => p._id !== personId));
      toast({ title: 'Failed to archive', status: 'error', duration: 3000 });
    }
  };

  const handleUnarchivePerson = async (personId: string) => {
    const person = archivedPeople.find(p => p._id === personId);
    if (!person) return;
    setArchivedPeople(prev => prev.filter(p => p._id !== personId));
    setPeople(prev => [...prev, person]);
    try {
      await api.unarchivePerson(personId);
      toast({ title: `${person.name} unarchived`, status: 'success', duration: 2000 });
    } catch {
      setPeople(prev => prev.filter(p => p._id !== personId));
      setArchivedPeople(prev => [...prev, person]);
      toast({ title: 'Failed to unarchive', status: 'error', duration: 3000 });
    }
  };

  const handlePersonClick = (person: Person) => {
    setSelectedPerson({ id: person._id, name: person.name });
    onDrawerOpen();
  };

  const handleSuggestedAdded = (names: string[]) => {
    setTrackedPeople(prev => {
      const next = new Set(prev);
      names.forEach(n => next.add(n.toLowerCase()));
      return next;
    });
  };

  const handlePersonAdded = (personName: string) => {
    setTrackedPeople(prev => new Set([...prev, personName.toLowerCase()]));
    fetchPeople();
  };

  if (loading && people.length === 0) {
    return <Flex pt={{ base: '20px', md: '10px' }} justify="center" align="center" h="50vh"><Spinner size="xl" /></Flex>;
  }

  if (error) {
    return (
      <Flex pt={{ base: '20px', md: '10px' }} justify="center" align="center" h="50vh">
        <VStack><Text color="red.500">{error}</Text><Button onClick={() => fetchPeople()}>Retry</Button></VStack>
      </Flex>
    );
  }

  return (
    <Box pt={{ base: '20px', md: '10px', xl: '10px' }}>
      <Flex justify="flex-end" align="center" mb={6} wrap="wrap" gap={3}>
        <Button leftIcon={<StarIcon />} colorScheme="yellow" variant="outline" size="sm" onClick={onSuggestOpen}>
          AI Suggested People
        </Button>
        <Button leftIcon={<AddIcon />} colorScheme="brand" variant="solid" size="sm" onClick={onAddOpen}>
          Add Person
        </Button>
        <InputGroup maxW="300px">
          <InputLeftElement><SearchIcon color="gray.400" /></InputLeftElement>
          <Input placeholder="Search people..." value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchPeople(searchTerm)} />
        </InputGroup>
      </Flex>

      {people.length === 0 ? (
        <Card p={8} textAlign="center">
          <VStack spacing={4}>
            <Text color="gray.500">No people tracked yet</Text>
            <Text fontSize="sm" color="gray.400">Record a meeting to auto-discover contacts, or click "AI Suggested People" to find people from your calendar.</Text>
          </VStack>
        </Card>
      ) : (
        <SimpleGrid columns={{ base: 1, md: 2, lg: 3, xl: 4 }} spacing={5}>
          {people.map(person => (
            <PersonCard key={person._id} person={person}
              isTracked={trackedPeople.has((person.name || '').toLowerCase())}
              onClick={() => handlePersonClick(person)}
              onArchive={handleArchivePerson} />
          ))}
        </SimpleGrid>
      )}

      <PersonDetailDrawer isOpen={isDrawerOpen} onClose={onDrawerClose}
        personId={selectedPerson?.id ?? null} personName={selectedPerson?.name ?? null} />

      <SuggestedPeopleModal isOpen={isSuggestOpen} onClose={onSuggestClose} onAdded={handleSuggestedAdded} />

      <AddPersonModal isOpen={isAddOpen} onClose={onAddClose} onAdded={handlePersonAdded} />

      {archivedPeople.length > 0 && (
        <Box position="fixed" bottom="24px" right="24px" zIndex={10}>
          <Button size="sm" variant="outline" leftIcon={<Icon as={MdArchive} />} onClick={() => setShowArchived(true)}
            bg={cardBg} borderColor={borderColor} boxShadow="md">
            Archived ({archivedPeople.length})
          </Button>
        </Box>
      )}

      <Drawer isOpen={showArchived} onClose={() => setShowArchived(false)} placement="right" size="sm">
        <DrawerOverlay />
        <DrawerContent>
          <DrawerCloseButton />
          <DrawerHeader>Archived People</DrawerHeader>
          <DrawerBody>
            <VStack spacing={3} align="stretch">
              {archivedPeople.map(person => (
                <Box key={person._id} p={4} borderWidth="1px" borderRadius="lg" borderColor={borderColor} bg={cardBg}>
                  <HStack justify="space-between" align="center">
                    <HStack spacing={3} flex={1} mr={2}>
                      <Avatar size="sm" name={person.name} />
                      <VStack align="start" spacing={0}>
                        <Text fontWeight="semibold" fontSize="sm">{person.name}</Text>
                        {(person.company || person.role) && (
                          <Text fontSize="xs" color="gray.500" noOfLines={1}>
                            {person.role ? `${person.role}${person.company ? ` at ${person.company}` : ''}` : person.company}
                          </Text>
                        )}
                      </VStack>
                    </HStack>
                    <Button size="xs" colorScheme="brand" variant="outline" leftIcon={<Icon as={MdUnarchive} />}
                      onClick={() => handleUnarchivePerson(person._id)} flexShrink={0}>
                      Unarchive
                    </Button>
                  </HStack>
                </Box>
              ))}
            </VStack>
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </Box>
  );
}
