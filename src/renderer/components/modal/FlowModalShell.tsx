/**
 * FlowModalShell — shared shell for all Inwise modals.
 *
 * Provides:
 *  - FlowModalOverlay    blurred backdrop
 *  - FlowModalContent    white panel, rounded, shadow
 *  - FlowModalHeader     title / subtitle / status dot / close button
 *  - FlowModalBody       padded scrollable body
 *  - FlowModalFooter     cancel + confirm + optional extra slot
 *  - FlowFormLabel       uppercase field label
 *  - fieldAnim(i)        stagger helper for form fields
 *  - INPUT_PROPS         consistent input styling
 *  - SELECT_PROPS        consistent select styling
 *  - TEXTAREA_PROPS      consistent textarea styling
 *  - FLOW_SPRING         shared spring physics
 *
 * Usage:
 *   <Modal isOpen={isOpen} onClose={onClose} motionPreset="scale" size="lg">
 *     <FlowModalOverlay />
 *     <FlowModalContent>
 *       <FlowModalHeader title="Add Key Result" subtitle="OKRs · Q2 2026" />
 *       <FlowModalBody>...</FlowModalBody>
 *       <FlowModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Save" isLoading={isLoading} />
 *     </FlowModalContent>
 *   </Modal>
 */
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ModalContent,
  ModalOverlay,
  ModalCloseButton,
  FormLabel,
  Box,
  HStack,
  Text,
  Heading,
  Button
} from '@chakra-ui/react';
import type { ModalContentProps } from '@chakra-ui/react';

// ─── Shared constants ─────────────────────────────────────────────────────────

export const FLOW_SPRING = { type: 'spring' as const, stiffness: 380, damping: 26, mass: 0.75 };

export const INPUT_PROPS = {
  borderRadius: '8px',
  borderColor: 'gray.200',
  fontSize: '13px',
  _focus: { borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }
};

export const SELECT_PROPS = {
  borderRadius: '8px',
  borderColor: 'gray.200',
  fontSize: '13px',
  _focus: { borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }
};

export const TEXTAREA_PROPS = {
  borderRadius: '8px',
  borderColor: 'gray.200',
  fontSize: '13px',
  lineHeight: '20px',
  resize: 'none' as const,
  _focus: { borderColor: '#1a7080', boxShadow: '0 0 0 1px #1a7080' }
};

/** Staggered entry animation for form fields — pass the field index */
export function fieldAnim(i: number) {
  return {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { delay: i * 0.05, type: 'spring' as const, stiffness: 380, damping: 26 }
  };
}

// ─── FlowModalOverlay ────────────────────────────────────────────────────────

export const FlowModalOverlay: React.FC = () => (
  <ModalOverlay bg="blackAlpha.500" sx={{ backdropFilter: 'blur(4px)' }} />
);

// ─── FlowModalContent ────────────────────────────────────────────────────────

export const FlowModalContent: React.FC<ModalContentProps> = ({ children, ...rest }) => (
  <ModalContent
    borderRadius="20px"
    overflow="hidden"
    boxShadow="0 24px 64px rgba(0,0,0,0.10), 0 4px 16px rgba(0,0,0,0.05)"
    mx={4}
    bg="white"
    fontFamily="body"
    {...rest}
  >
    {children}
  </ModalContent>
);

// ─── FlowModalHeader ─────────────────────────────────────────────────────────

const STATUS_PALETTE = {
  active:   { dot: 'blue.400',   label: 'blue.600' },
  complete: { dot: 'green.400',  label: 'green.600' },
  loading:  { dot: 'orange.400', label: 'orange.600' },
  ai:       { dot: 'purple.400', label: 'purple.600' },
  warning:  { dot: 'red.400',    label: 'red.600' }
};

export interface FlowModalHeaderProps {
  title: string;
  subtitle?: string;
  status?: keyof typeof STATUS_PALETTE;
  statusLabel?: string;
}

export const FlowModalHeader: React.FC<FlowModalHeaderProps> = ({ title, subtitle, status, statusLabel }) => {
  const c = status ? STATUS_PALETTE[status] : null;
  return (
    <Box px={7} pt={5} pb={4} borderBottom="1px solid" borderColor="gray.100">
      {c && statusLabel && (
        <HStack mb="4px" spacing="6px">
          <Box w="7px" h="7px" borderRadius="full" bg={c.dot} />
          <Text fontSize="10px" fontWeight="700" color={c.label} letterSpacing="0.07em" textTransform="uppercase">
            {statusLabel}
          </Text>
        </HStack>
      )}
      <Heading size="md" color="gray.800" fontWeight="700" letterSpacing="-0.01em" pr={8}>
        {title}
      </Heading>
      {subtitle && (
        <Text fontSize="12px" color="gray.400" mt="2px">{subtitle}</Text>
      )}
      <ModalCloseButton
        top={4}
        right={5}
        size="sm"
        borderRadius="8px"
        color="gray.400"
        _hover={{ bg: 'gray.100', color: 'gray.600' }}
      />
    </Box>
  );
};

// ─── FlowModalBody ───────────────────────────────────────────────────────────

export interface FlowModalBodyProps {
  children: React.ReactNode;
  maxH?: string;
  noPad?: boolean;
}

export const FlowModalBody: React.FC<FlowModalBodyProps> = ({
  children,
  maxH = 'calc(75vh - 130px)',
  noPad
}) => (
  <Box
    px={noPad ? 0 : 7}
    py={noPad ? 0 : 5}
    overflowY="auto"
    maxH={maxH}
  >
    {children}
  </Box>
);

// ─── FlowModalFooter ─────────────────────────────────────────────────────────

export interface FlowModalFooterProps {
  onCancel?: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  isLoading?: boolean;
  isDisabled?: boolean;
  confirmColorScheme?: string;
  extra?: React.ReactNode;
}

export const FlowModalFooter: React.FC<FlowModalFooterProps> = ({
  onCancel,
  onConfirm,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  isLoading,
  isDisabled,
  confirmColorScheme = 'brand',
  extra
}) => (
  <Box px={7} py={4} borderTop="1px solid" borderColor="gray.100" bg="gray.50">
    <HStack justify="space-between">
      <Box>{extra}</Box>
      <HStack spacing={2}>
        {onCancel && (
          <Button size="sm" variant="ghost" colorScheme="gray" fontSize="12px" onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
        {onConfirm && (
          <Button
            size="sm"
            colorScheme={confirmColorScheme}
            borderRadius="8px"
            fontSize="12px"
            px={5}
            onClick={onConfirm}
            isLoading={isLoading}
            isDisabled={isDisabled}
          >
            {confirmLabel}
          </Button>
        )}
      </HStack>
    </HStack>
  </Box>
);

// ─── FlowFormLabel ───────────────────────────────────────────────────────────

export const FlowFormLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <FormLabel
    fontSize="10.5px"
    fontWeight="700"
    color="gray.500"
    textTransform="uppercase"
    letterSpacing="0.06em"
    mb={1}
  >
    {children}
  </FormLabel>
);

// ─── AI Suggestion Status Banner ────────────────────────────────────────────

export const AiSuggestionBanner: React.FC<{
  isLoading: boolean;
  hasData: boolean;
  noData: boolean;
}> = ({ isLoading, hasData, noData }) => {
  if (isLoading) {
    return (
      <Box px={3} py={2} borderRadius="8px" border="1px solid" borderColor="#9dd4d9" bg="#f0fafa">
        <HStack spacing={2}>
          <Box w="6px" h="6px" borderRadius="full" bg="#1a7080" />
          <Text fontSize="12px" color="#1a7080">Analyzing — checking what Inwise knows...</Text>
        </HStack>
      </Box>
    );
  }
  if (noData) {
    return (
      <Box px={3} py={2} borderRadius="8px" border="1px solid" borderColor="gray.200" bg="gray.50">
        <Text fontSize="12px" color="gray.500">
          Inwise is still learning about your team and projects. After a few meetings, fields will pre-fill automatically.
        </Text>
      </Box>
    );
  }
  if (hasData) {
    return (
      <Box px={3} py={2} borderRadius="8px" border="1px solid" borderColor="#9dd4d9" bg="#f0fafa">
        <Text fontSize="12px" color="#1a7080">
          Fields below are AI-suggested from your meetings. Click any to edit.
        </Text>
      </Box>
    );
  }
  return null;
};

// ─── Re-exports for convenience ──────────────────────────────────────────────

export { motion, AnimatePresence };
