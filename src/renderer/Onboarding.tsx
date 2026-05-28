import React from 'react';
import { OnboardingFlow } from '@inwise/desktop-shared';
import { ossOnboardingAdapter } from './adapters/ossOnboardingAdapter';

interface Props {
  onComplete: () => void;
}

export default function Onboarding({ onComplete }: Props) {
  return <OnboardingFlow adapter={ossOnboardingAdapter} onComplete={onComplete} />;
}
