import React, { useEffect, useState } from 'react';
import {
  Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Box, Button, HStack, VStack, Text, Heading,
} from '@chakra-ui/react';

export interface ConflictMeeting {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  attendees: string[];
  meetingLink?: string;
  sourceCalendarId?: string;
}

interface Props {
  isOpen: boolean;
  active: ConflictMeeting | null;
  incoming: ConflictMeeting | null;
  autoSelectMs: number;
  onPick: (chosenId: string) => void;
}

function formatStart(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function MeetingCard({
  meeting, label, onPick,
}: {
  meeting: ConflictMeeting;
  label: string;
  onPick: (id: string) => void;
}) {
  return (
    <Box
      flex="1"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="10px"
      p={4}
      bg="white"
    >
      <Text fontSize="11px" textTransform="uppercase" color="gray.500" mb={1}>{label}</Text>
      <Heading as="h4" size="sm" mb={2} noOfLines={2}>{meeting.title || '(no title)'}</Heading>
      <VStack align="start" spacing={1} mb={3}>
        <Text fontSize="12px" color="gray.600">Starts at {formatStart(meeting.startTime)}</Text>
        <Text fontSize="12px" color="gray.600">{meeting.attendees.length} attendee{meeting.attendees.length === 1 ? '' : 's'}</Text>
      </VStack>
      <Button
        size="sm"
        colorScheme="teal"
        width="100%"
        onClick={() => onPick(meeting.id)}
      >
        Record this one
      </Button>
    </Box>
  );
}

export default function MeetingConflictModal({ isOpen, active, incoming, autoSelectMs, onPick }: Props) {
  const [remainingMs, setRemainingMs] = useState(autoSelectMs);

  useEffect(() => {
    if (!isOpen) return;
    setRemainingMs(autoSelectMs);
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const left = Math.max(0, autoSelectMs - (Date.now() - startedAt));
      setRemainingMs(left);
      if (left <= 0) clearInterval(tick);
    }, 250);
    return () => clearInterval(tick);
  }, [isOpen, autoSelectMs]);

  if (!active || !incoming) return null;
  const secondsLeft = Math.ceil(remainingMs / 1000);

  return (
    <Modal isOpen={isOpen} onClose={() => { /* not dismissable — main process resolves */ }} size="xl" isCentered closeOnOverlayClick={false} closeOnEsc={false}>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Two meetings starting at once</ModalHeader>
        <ModalBody>
          <Text fontSize="13px" color="gray.600" mb={4}>
            Pick which one to record. Auto-selecting the likely match in <strong>{secondsLeft}s</strong>.
          </Text>
          <HStack align="stretch" spacing={3}>
            <MeetingCard meeting={active} label="Already in progress" onPick={onPick} />
            <MeetingCard meeting={incoming} label="Just started" onPick={onPick} />
          </HStack>
        </ModalBody>
        <ModalFooter>
          <Text fontSize="11px" color="gray.500">
            The meeting you don't pick stays in your upcoming list — you can record it later.
          </Text>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
