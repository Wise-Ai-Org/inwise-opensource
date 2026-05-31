import React, { useState } from 'react';
import {
  Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton,
  ModalBody, ModalFooter, Button, FormControl, FormLabel, Input,
  Textarea, VStack, useToast,
} from '@chakra-ui/react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (data: { title: string; content: string; date: string }) => Promise<void>;
}

export default function TranscriptUploadModal({ isOpen, onClose, onUpload }: Props) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) {
      toast({ title: 'Please fill in title and transcript', status: 'warning', duration: 3000 });
      return;
    }
    setLoading(true);
    try {
      await onUpload({ title: title.trim(), content: content.trim(), date: new Date(date).toISOString() });
      toast({ title: 'Transcript uploaded', status: 'success', duration: 3000 });
      setTitle('');
      setContent('');
      setDate(new Date().toISOString().slice(0, 10));
      onClose();
    } catch (err: any) {
      toast({ title: 'Upload failed', description: err.message, status: 'error', duration: 4000 });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Upload Transcript</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <VStack spacing={4}>
            <FormControl isRequired>
              <FormLabel>Meeting Title</FormLabel>
              <Input
                placeholder="e.g. Q1 Planning Session"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Meeting Date</FormLabel>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </FormControl>
            <FormControl isRequired>
              <FormLabel>Transcript</FormLabel>
              <Textarea
                placeholder="Paste the full meeting transcript here…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                fontFamily="mono"
                fontSize="sm"
              />
            </FormControl>
          </VStack>
        </ModalBody>
        <ModalFooter gap={3}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button colorScheme="brand" onClick={handleSubmit} isLoading={loading}>
            Upload & Process
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
