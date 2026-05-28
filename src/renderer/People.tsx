import React from 'react';
import { PeopleView } from '@inwise/desktop-shared';
import { ossPeopleAdapter } from './adapters/ossPeopleAdapter';

export default function People() {
  return <PeopleView adapter={ossPeopleAdapter} />;
}
