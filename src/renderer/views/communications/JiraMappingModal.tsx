import React, { useState, useEffect } from 'react';
import {
  Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter,
  ModalCloseButton, Button, VStack, HStack, Box, Text, Badge, Spinner,
  Select, Flex, Icon, Tooltip, useToast, Divider, Switch, FormControl, FormLabel
} from '@chakra-ui/react';
import { CheckIcon, ExternalLinkIcon, WarningIcon } from '@chakra-ui/icons';
import { MdAutoAwesome, MdLink, MdAdd } from 'react-icons/md';

interface MatchCandidate {
  jiraKey: string;
  title: string;
  similarity: number;
  matchFactors: { keyMention: number; keywords: number; title: number };
  jiraUrl: string;
}

interface MatchResult {
  itemText: string;
  itemOwner?: string;
  candidates: MatchCandidate[];
  bestMatch: MatchCandidate | null;
  autoApproved: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  actionItems: { text: string; owner?: string }[];
  meetingTitle: string;
  meetingId: string;
  onComplete: () => void;
}

type ItemAction = 'skip' | 'link' | 'create';

interface ItemDecision {
  action: ItemAction;
  selectedKey: string | null; // jiraKey for 'link', null for 'create' or 'skip'
}

export default function JiraMappingModal({ isOpen, onClose, actionItems, meetingTitle, meetingId, onComplete }: Props) {
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [stories, setStories] = useState<any[]>([]);
  const [decisions, setDecisions] = useState<ItemDecision[]>([]);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [autoPush, setAutoPush] = useState(false);
  const [result, setResult] = useState<{ created: number; linked: number; skipped: number } | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (isOpen && actionItems.length > 0) {
      loadMatches();
    }
  }, [isOpen]);

  // Seed each item's mapping decision. When pre-fill is on we default to the best
  // match (link) or create; when off, everything starts as skip and the user opts
  // in per item. Either way nothing is written until the explicit Apply click.
  const seedDecisions = (matchList: MatchResult[], prefill: boolean): ItemDecision[] =>
    matchList.map((m) => {
      if (!prefill) return { action: 'skip' as ItemAction, selectedKey: null };
      if (m.bestMatch && (m.autoApproved || m.bestMatch.similarity >= 0.5)) {
        return { action: 'link' as ItemAction, selectedKey: m.bestMatch.jiraKey };
      }
      return { action: 'create' as ItemAction, selectedKey: null };
    });

  const loadMatches = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const config = await (window as any).inwiseAPI.getConfig();
      const projectKey = config?.jiraDefaultProject || undefined;
      const prefill = !!config?.jiraAutoPush;
      setAutoPush(prefill);
      const result = await (window as any).inwiseAPI.jiraMatchTasks(actionItems, projectKey);

      if (!result.ok) {
        setError(result.error || 'Failed to match tasks');
        setLoading(false);
        return;
      }

      setMatches(result.matches);
      setStories(result.stories);

      setDecisions(seedDecisions(result.matches, prefill));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const updateDecision = (idx: number, update: Partial<ItemDecision>) => {
    setDecisions(prev => prev.map((d, i) => i === idx ? { ...d, ...update } : d));
  };

  // Persist the auto-push preference so next time the panel pre-fills the same way.
  // The toggle only controls how decisions are seeded — it never writes to Jira on
  // its own; the explicit Apply click below is still the only thing that writes.
  const toggleAutoPush = async (next: boolean) => {
    setAutoPush(next);
    setDecisions(seedDecisions(matches, next));
    try { await (window as any).inwiseAPI.setConfig({ jiraAutoPush: next }); } catch { /* best-effort */ }
  };

  const handleApply = async () => {
    setApplying(true);
    const api = (window as any).inwiseAPI;
    let created = 0;
    let linked = 0;
    let skipped = 0;

    try {
      const config = await api.getConfig();
      const projectKey = config?.jiraDefaultProject;

      for (let i = 0; i < decisions.length; i++) {
        const decision = decisions[i];
        const item = actionItems[i];

        if (decision.action === 'skip') {
          skipped++;
          continue;
        }

        if (decision.action === 'create') {
          if (!projectKey) {
            toast({ title: 'Set a default Jira project in Settings first', status: 'warning', duration: 3000 });
            continue;
          }
          const result = await api.jiraCreateIssue({
            title: item.text,
            description: `From meeting: ${meetingTitle}\nOwner: ${item.owner || 'Unassigned'}`,
            priority: 'medium',
            projectKey,
          });
          if (result.ok) created++;
        }

        if (decision.action === 'link' && decision.selectedKey) {
          const story = stories.find((s: any) => s.jiraKey === decision.selectedKey);
          if (story) {
            await api.jiraAddComment(decision.selectedKey,
              `Action item: ${item.text}\nOwner: ${item.owner || 'Unassigned'}`,
              meetingTitle
            );
            linked++;
          }
        }
      }

      // Show the result in-panel (instead of closing on a transient toast) so the
      // user always sees exactly what was written to Jira.
      setResult({ created, linked, skipped });
      onComplete();
    } catch (e: any) {
      toast({ title: 'Sync failed', description: e.message, status: 'error', duration: 4000 });
    } finally {
      setApplying(false);
    }
  };

  const actionCounts = decisions.reduce((acc, d) => {
    acc[d.action] = (acc[d.action] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent maxW="700px">
        <ModalHeader>
          <HStack spacing={2}>
            <Icon as={MdAutoAwesome} color="orange.500" />
            <Text>Map to Jira</Text>
          </HStack>
          <Text fontSize="sm" color="gray.500" fontWeight="normal" mt={1}>
            {actionItems.length} action item{actionItems.length !== 1 ? 's' : ''} from "{meetingTitle}"
          </Text>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={4}>
          {result ? (
            <Box p={4} bg="green.50" borderRadius="md" border="1px solid" borderColor="green.200">
              <HStack spacing={2} mb={1}>
                <CheckIcon color="green.500" />
                <Text fontWeight="semibold">Jira sync complete</Text>
              </HStack>
              <Text fontSize="sm" color="gray.700">
                {result.created} created · {result.linked} updated · {result.skipped} skipped
              </Text>
            </Box>
          ) : loading ? (
            <Flex justify="center" py={10}><Spinner size="lg" /><Text ml={3} color="gray.500">Matching against Jira stories...</Text></Flex>
          ) : error ? (
            <Box p={4} bg="red.50" borderRadius="md"><Text color="red.600">{error}</Text></Box>
          ) : (
            <VStack align="stretch" spacing={3} divider={<Divider />}>
              {matches.map((match, idx) => (
                <Box key={idx}>
                  <Text fontSize="sm" fontWeight="semibold" mb={1}>{match.itemText}</Text>
                  {match.itemOwner && <Text fontSize="xs" color="gray.500" mb={2}>Owner: {match.itemOwner}</Text>}

                  <HStack spacing={2} mb={2}>
                    <Button size="xs" variant={decisions[idx]?.action === 'create' ? 'solid' : 'outline'}
                      colorScheme="green" leftIcon={<Icon as={MdAdd} />}
                      onClick={() => updateDecision(idx, { action: 'create', selectedKey: null })}>
                      Create New
                    </Button>
                    <Button size="xs" variant={decisions[idx]?.action === 'skip' ? 'solid' : 'outline'}
                      colorScheme="gray"
                      onClick={() => updateDecision(idx, { action: 'skip', selectedKey: null })}>
                      Skip
                    </Button>
                  </HStack>

                  {match.candidates.length > 0 && (
                    <VStack align="stretch" spacing={1}>
                      <Text fontSize="xs" color="gray.500" fontWeight="semibold">MATCH CANDIDATES</Text>
                      {match.candidates.slice(0, 3).map(candidate => {
                        const isSelected = decisions[idx]?.action === 'link' && decisions[idx]?.selectedKey === candidate.jiraKey;
                        return (
                          <Box key={candidate.jiraKey} p={2} borderRadius="md" cursor="pointer"
                            bg={isSelected ? 'blue.50' : 'gray.50'}
                            border="1px solid" borderColor={isSelected ? 'blue.300' : 'gray.200'}
                            onClick={() => updateDecision(idx, { action: 'link', selectedKey: candidate.jiraKey })}
                            _hover={{ borderColor: 'blue.300' }}>
                            <Flex justify="space-between" align="center">
                              <HStack spacing={2} flex={1}>
                                {isSelected && <CheckIcon color="blue.500" boxSize="10px" />}
                                <Badge colorScheme="gray" fontSize="xs">{candidate.jiraKey}</Badge>
                                <Text fontSize="sm" noOfLines={1}>{candidate.title}</Text>
                              </HStack>
                              <HStack spacing={2}>
                                <Badge colorScheme={candidate.similarity >= 0.8 ? 'green' : candidate.similarity >= 0.5 ? 'yellow' : 'gray'}
                                  fontSize="xs">
                                  {Math.round(candidate.similarity * 100)}%
                                </Badge>
                                {match.autoApproved && candidate === match.bestMatch && (
                                  <Tooltip label="Auto-matched with high confidence">
                                    <Badge colorScheme="green" fontSize="xs">Auto</Badge>
                                  </Tooltip>
                                )}
                              </HStack>
                            </Flex>
                          </Box>
                        );
                      })}
                    </VStack>
                  )}
                </Box>
              ))}
            </VStack>
          )}
        </ModalBody>
        <ModalFooter>
          {result ? (
            <Button colorScheme="blue" onClick={onClose}>Done</Button>
          ) : (
            <>
              <HStack spacing={4} mr="auto">
                <FormControl display="flex" alignItems="center" w="auto" mb={0}>
                  <FormLabel htmlFor="jira-autopush" fontSize="xs" color="gray.500" mb={0} mr={2}>
                    Pre-fill from matches
                  </FormLabel>
                  <Switch id="jira-autopush" size="sm" isChecked={autoPush}
                    onChange={(e) => toggleAutoPush(e.target.checked)} />
                </FormControl>
                <HStack spacing={2}>
                  {actionCounts.create > 0 && <Badge colorScheme="green" fontSize="xs">{actionCounts.create} create</Badge>}
                  {actionCounts.link > 0 && <Badge colorScheme="blue" fontSize="xs">{actionCounts.link} link</Badge>}
                  {actionCounts.skip > 0 && <Badge colorScheme="gray" fontSize="xs">{actionCounts.skip} skip</Badge>}
                </HStack>
              </HStack>
              <Button variant="ghost" onClick={onClose} mr={2}>Cancel</Button>
              <Button colorScheme="blue" onClick={handleApply} isLoading={applying}
                disabled={loading || decisions.every(d => d.action === 'skip')}>
                Apply
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
