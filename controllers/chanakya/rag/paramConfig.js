const ALLOWED_DOSTS = {
  'Concept Dost': ['concept'],
  'Revision Dost': ['revision'],
  'Formula Dost': ['formula'],
  'Practice Dost': ['practiceAssignment', 'practiceTest'],
  'Speed Booster Dost': ['clickingPower', 'pickingPower', 'speedRace'],
};

const SPECS = {
  practiceAssignment: {
    expected_fields: ['difficulty', 'type_split', 'isNCERT'],
    defaults: {
      difficulty: 'easy',
      isNCERT: false,
      type_split: {
        scq: 20,
        mcq: 10,
        integerQuestion: 5,
        passageQuestion: 0,
        matchQuestion: 0,
      },
    },
  },

  practiceTest: {
    expected_fields: ['difficulty', 'duration_minutes', 'paperPattern', 'isNCERT'],
    defaults: {
      difficulty: 'easy',
      isNCERT: false,
      duration_minutes: 60,
      paperPattern: 'Mains',
    },
  },

  formula: {
    expected_fields: [],
    defaults: {},
  },

  revision: {
    expected_fields: [
      'allotedDay',
      'importance',
      'allotedTime',
      'strategy',
      'daywiseTimePerPortion',
    ],
    defaults: {
      allotedDay: 3,
      allotedTime: 1,
      strategy: 1,
      daywiseTimePerPortion: 60,
      taskTypes: ['assignment', 'test'],
      importance: null,
    },
  },

  clickingPower: {
    expected_fields: [],
    defaults: {
      totalQuestions: 10,
    },
  },

  pickingPower: {
    expected_fields: [],
    defaults: {},
  },

  speedRace: {
    expected_fields: ['rank'],
    defaults: {
      rank: 100,
      opponentType: 'bot',
      scheduledTime: '',
      duration: '',
    },
  },

  concept: {
    expected_fields: [],
    defaults: {},
  },
};

const getParamSpecs = (dostType) => {
  return SPECS[dostType] ?? {
    expected_fields: [],
    defaults: {},
  };
};

const getAllowedDostTypes = () => {
  return Object.values(ALLOWED_DOSTS).flatMap((group) => [...group]);
};

module.exports = {
  ALLOWED_DOSTS,
  getParamSpecs,
  getAllowedDostTypes,
};