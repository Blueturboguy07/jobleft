// Word lists the resume lane uses to find facts in text: skills and tools (with their short forms), certifications
// and licences, degrees, job-title words, section headings, and ordinary capitalised words. Written for jobleft
// (no copied list). Format of a SKILLS line: "Canonical|alias|alias". A leading "=" makes the match case-sensitive
// (for names that are also ordinary words: "Go", "Swift", "Rust", "Excel"). "~" marks an alias that is only a
// short form (it is never shown as the canonical name).

const SKILL_LINES = String.raw`
JavaScript|=JS|ECMAScript|ES6|ES2015|Javascript
TypeScript|=TS
Python|Python 3|Python3
Java|Java 8|Java 11|Java 17|Core Java
=C
C++|cpp|C plus plus
C#|C Sharp|csharp
=Go|Golang
=Rust
=Ruby
PHP
=Swift
Kotlin
Scala
=R
MATLAB|Matlab
Perl
Haskell
Elixir
Erlang
Clojure
=Dart
Lua
=Julia
Objective-C|ObjC
F#
OCaml
=Groovy
Visual Basic|VB.NET|VB
VBA
Fortran
COBOL
Prolog
Lisp|Common Lisp
Solidity
=Zig
Assembly language|x86 assembly|ARM assembly
SQL|T-SQL|PL/SQL|Structured Query Language
NoSQL
=Bash|Bash scripting
Shell scripting|shell scripts|shell script
PowerShell
HTML|HTML5
CSS|CSS3
Sass|SCSS
Tailwind CSS|Tailwind|TailwindCSS
=Bootstrap
=React|React.js|ReactJS|React JS
React Native
Angular|AngularJS|Angular.js
Vue.js|Vue|VueJS|Vue 3
Svelte|SvelteKit
Next.js|NextJS|Next JS
Nuxt|Nuxt.js
=Gatsby
Redux|Redux Toolkit
jQuery
Node.js|=Node|NodeJS|Node JS
Express.js|ExpressJS
NestJS|Nest.js
Deno
GraphQL
REST APIs|=REST|RESTful|REST API|RESTful APIs|RESTful API
gRPC
WebSockets|WebSocket
OAuth|OAuth 2.0|OAuth2
JWT
Webpack
=Vite
=Babel
=Jest
=Mocha
=Cypress
=Playwright
Selenium
=Storybook
Three.js
D3.js|D3
WebGL
Progressive Web Apps|PWA
Web accessibility|WCAG|a11y
Django
=Flask
FastAPI
Spring Boot|Spring Framework|Spring MVC
Ruby on Rails|=Rails
Laravel
Symfony
.NET|dotnet|.NET Core|.NET Framework
ASP.NET|ASP.NET Core
Entity Framework
Hibernate
Microservices|microservice architecture
Distributed systems
System design
Event-driven architecture
RabbitMQ
=Celery
Redis
Memcached
Elasticsearch|Elastic Search
OpenSearch
Solr|Apache Solr
PostgreSQL|Postgres|Postgresql|PSQL
MySQL
MariaDB
SQLite
MongoDB|Mongo
Cassandra|Apache Cassandra
DynamoDB|Amazon DynamoDB
CockroachDB
Neo4j
Oracle Database|Oracle DB|Oracle SQL
SQL Server|MSSQL|Microsoft SQL Server|MS SQL
Firebase
Supabase
Prisma
iOS
Android
SwiftUI
UIKit
Jetpack Compose
=Flutter
Xamarin
AWS|Amazon Web Services
GCP|Google Cloud|Google Cloud Platform
Azure|Microsoft Azure
Docker|Docker Compose
Kubernetes|k8s|K8s|kubernetes
=Helm
Terraform
Ansible
=Puppet
CloudFormation|AWS CloudFormation
Pulumi
Jenkins
GitHub Actions
GitLab CI|GitLab CI/CD
CircleCI
Travis CI
CI/CD|CI CD|continuous integration|continuous delivery|continuous deployment
Git
GitHub
GitLab
Bitbucket
Linux
Unix
Nginx
Apache HTTP Server
Prometheus
Grafana
Datadog
Splunk
New Relic
ELK Stack|ELK|Elastic Stack
OpenTelemetry
Istio
=Serverless|serverless architecture|serverless computing
AWS Lambda|=Lambda
EC2|Amazon EC2
S3|Amazon S3
ECS|Amazon ECS
EKS|Amazon EKS
RDS|Amazon RDS
CloudWatch
SQS|Amazon SQS
SNS|Amazon SNS
Cloud Run
OpenShift
VMware
=Vagrant
Kafka|Apache Kafka
Apache Spark|Spark|PySpark|=Spark
Hadoop|Apache Hadoop
Apache Airflow|Airflow
=dbt
=Snowflake
BigQuery|Google BigQuery
Redshift|Amazon Redshift
Databricks
Apache Flink|Flink
Apache Hive|=Hive
Tableau
Power BI|PowerBI
Looker
Jupyter|Jupyter Notebook
pandas|Pandas
NumPy|Numpy
SciPy
scikit-learn|sklearn|scikit learn|Scikit-learn
TensorFlow|Tensorflow
PyTorch|Pytorch
Keras
XGBoost
LightGBM
Hugging Face|HuggingFace
LangChain
Large language models|LLMs|LLM
Machine learning|=ML
Deep learning
Natural language processing|NLP
Computer vision
Reinforcement learning
Data analysis|data analytics
Data visualization
Data engineering
Data modeling|data modelling
Data warehousing|data warehouse
ETL|ELT
Statistics|statistical analysis
A/B testing|AB testing|split testing
Time series analysis|time series
=Excel|Microsoft Excel|MS Excel
Google Sheets
Microsoft Office|MS Office|Office 365|Microsoft 365
PowerPoint|Microsoft PowerPoint
Microsoft Word|MS Word
Microsoft Access|MS Access
Microsoft Project|MS Project
Microsoft Teams
=Outlook|Microsoft Outlook
SharePoint
Visio|Microsoft Visio
Salesforce
HubSpot
Marketo
Mailchimp
Zendesk
ServiceNow
=SAP
NetSuite
QuickBooks
Xero
Workday HCM
Jira
=Confluence
=Asana
Trello
=Notion
=Slack
Figma
=Sketch
Adobe XD
Photoshop|Adobe Photoshop
=Illustrator|Adobe Illustrator
InDesign|Adobe InDesign
=After Effects|Adobe After Effects
Premiere Pro|Adobe Premiere Pro|Adobe Premiere
Adobe Creative Suite|Adobe Creative Cloud
=Blender
=Unity|Unity3D|Unity 3D
Unreal Engine
User research|UX research
Usability testing
Wireframing|wireframes
Prototyping
Design systems
UX design|user experience design
UI design|user interface design
Agile|agile methodologies
Scrum
Kanban
=Lean
Six Sigma|Lean Six Sigma
Project management
Product management
Stakeholder management
Roadmapping|product roadmaps
OKRs
TDD|test-driven development
BDD|behavior-driven development
Unit testing
Integration testing
Test automation|automated testing
QA|quality assurance
JUnit
pytest|PyTest
=Postman
Embedded systems
RTOS
FPGA
Verilog
VHDL
PCB design
Arduino
Raspberry Pi
Microcontrollers
AutoCAD
SolidWorks
CATIA
ANSYS
LabVIEW
PLC programming|PLC
GIS
ArcGIS
Cybersecurity|cyber security|information security
Penetration testing|pen testing
SIEM
SOC 2|SOC2
ISO 27001
IAM|identity and access management
OWASP
Threat modeling
Incident response
Vulnerability management
Network security
Zero trust
TCP/IP
DNS
VPN
Active Directory
Windows Server
ITIL
SEO|search engine optimization
SEM|search engine marketing
Google Ads|AdWords
Google Analytics|GA4
Content marketing
Social media marketing
Email marketing
Copywriting
CRM
Financial modeling|financial modelling
Forecasting
Budgeting
Accounts payable
Accounts receivable
Account reconciliation|reconciliations
Auditing
GAAP|US GAAP
IFRS
Bloomberg Terminal|Bloomberg
=Epic|Epic EHR|Epic Systems
Cerner
Meditech
EHR|EMR|electronic health records|electronic medical records
HIPAA
Phlebotomy
Triage
IV therapy
Medication administration
Wound care
Telemetry
Patient care
Spanish
French
German
Mandarin|Mandarin Chinese
Cantonese
Japanese
Korean
Portuguese
Italian
Arabic
Hindi
Russian
Vietnamese
Tagalog
`;

const CERT_LINES = String.raw`
PMP|Project Management Professional
CAPM
Certified ScrumMaster|=CSM
Professional Scrum Master|PSM
CPA|Certified Public Accountant
CFA|Chartered Financial Analyst
CMA|Certified Management Accountant
CFP|Certified Financial Planner
FRM
CISSP
CISM
CISA
CEH|Certified Ethical Hacker
OSCP
CompTIA Security+|Security+
CompTIA Network+|Network+
CompTIA A+
CCNA
CCNP
CKA|Certified Kubernetes Administrator
CKAD|Certified Kubernetes Application Developer
RHCSA
RHCE
Six Sigma Green Belt|Green Belt
Six Sigma Black Belt|Black Belt
SHRM-CP
SHRM-SCP
PHR
Registered Nurse license|RN license|licensed RN
LPN|Licensed Practical Nurse
NCLEX|NCLEX-RN
BLS|Basic Life Support
ACLS|Advanced Cardiovascular Life Support
PALS|Pediatric Advanced Life Support
NRP
CPR
EMT
CNA|Certified Nursing Assistant
Series 7
Series 63
Series 65
Series 66
Professional Engineer license|PE license|licensed Professional Engineer
EIT|Engineer in Training
LEED AP|LEED Green Associate
Security clearance|TS/SCI|Top Secret clearance|Secret clearance|Top Secret|active clearance|public trust clearance|DoD clearance
Bar admission|licensed attorney|admitted to the bar
`;

/** AWS/Azure/GCP certification names follow a pattern; any of these is a certification fact. */
export const CERT_PATTERNS: readonly RegExp[] = [
  /\bAWS Certified [A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*){0,4}(?: -? ?(?:Associate|Professional|Specialty|Foundational))?/g,
  /\bMicrosoft Certified: [A-Z][A-Za-z]*(?: [A-Za-z]+){0,6}/g,
  /\bAzure (?:Fundamentals|Administrator|Developer|Solutions Architect|Data Engineer|AI Engineer)(?: Associate| Expert)?/g,
  /\bAZ-\d{3}\b/g, /\bDP-\d{3}\b/g, /\bAI-\d{3}\b/g,
  /\bGoogle Cloud (?:Certified|Professional|Associate) [A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*){0,4}/g,
  /\b(?:[A-Z][a-z]+ )?Certified [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,4}\b/g,
];

export interface LexEntry {
  canonical: string;
  /** Every surface form, canonical first. */
  forms: string[];
  /** Forms that must match with exact case. */
  caseSensitive: Set<string>;
  kind: 'skill' | 'certification';
}

function parseLines(text: string, kind: LexEntry['kind']): LexEntry[] {
  const out: LexEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
    const cs = new Set<string>();
    const forms: string[] = [];
    for (const p of parts) {
      const exact = p.startsWith('=');
      const form = exact ? p.slice(1) : p;
      if (exact) cs.add(form);
      if (!forms.includes(form)) forms.push(form);
    }
    out.push({ canonical: forms[0]!, forms, caseSensitive: cs, kind });
  }
  return out;
}

export const SKILLS: readonly LexEntry[] = parseLines(SKILL_LINES, 'skill');
export const CERTS: readonly LexEntry[] = parseLines(CERT_LINES, 'certification');

/** Degree levels and the words that name them. Two-letter forms (BS, MA, MD) count only near "in"/"degree". */
export const DEGREE_LEVELS: ReadonlyArray<{ level: string; label: string; patterns: RegExp[] }> = [
  { level: 'highschool', label: 'High school diploma', patterns: [/\bhigh school diploma\b/gi, /\bGED\b/g] },
  { level: 'associate', label: "Associate's degree", patterns: [/\bassociate(?:'s|’s)? degree\b/gi, /\bassociate of (?:arts|science|applied science)\b/gi, /\bA\.A\.S?\.?(?=\s|,|$)/g, /\bA\.S\.(?=\s|,|$)/g, /\bAAS\b/g] },
  { level: 'bachelor', label: "Bachelor's degree", patterns: [
    /\bbachelor(?:'s|’s|s)?(?: degree)?\b/gi, /\bbachelor of [a-z]+(?: [a-z]+)?\b/gi, /\bB\.\s?S\.?c?\.?(?=[\s,)]|$)/g, /\bB\.\s?A\.(?=[\s,)]|$)/g,
    /\bB\.\s?E(?:ng)?\.(?=[\s,)]|$)/g, /\bB\.Tech\b/g, /\bBTech\b/g, /\bBSc\b/g, /\bBEng\b/g, /\bBBA\b/g, /\bBFA\b/g, /\bBSN\b/g, /\bBSEE\b/g, /\bBSCS\b/g, /\bundergraduate degree\b/gi,
    /\b(?:BS|BA)(?= in\b| degree\b|,? (?:Computer|Electrical|Mechanical|Civil|Chemical|Business|Economics|Mathematics|Physics|Biology|Psychology|English|History))/g,
  ] },
  { level: 'master', label: "Master's degree", patterns: [
    /\bmaster(?:'s|’s|s)?(?: degree)?\b/gi, /\bmaster of [a-z]+(?: [a-z]+)?\b/gi, /\bM\.\s?S\.?c?\.?(?=[\s,)]|$)/g, /\bM\.\s?A\.(?=[\s,)]|$)/g, /\bM\.\s?Eng\.?(?=[\s,)]|$)/g,
    /\bMSc\b/g, /\bMEng\b/g, /\bMBA\b/g, /\bM\.B\.A\.?/g, /\bMFA\b/g, /\bMPH\b/g, /\bMSN\b/g, /\bMPA\b/g, /\bM\.Tech\b/g, /\bMTech\b/g, /\bMSCS\b/g, /\bgraduate degree\b/gi,
    /\b(?:MS|MA)(?= in\b| degree\b)/g,
  ] },
  { level: 'doctorate', label: 'Doctorate (PhD)', patterns: [
    /\bPh\.?\s?D\.?(?=[\s,)]|$)/gi, /\bPhD\b/gi, /\bdoctorate\b/gi, /\bdoctoral(?: degree)?\b/gi, /\bD\.Phil\.?\b/g, /\bEdD\b/g, /\bEd\.D\.?/g, /\bDNP\b/g, /\bPharmD\b/g, /\bdoctor of [a-z]+\b/gi,
  ] },
  { level: 'professional', label: 'Professional degree (MD, JD)', patterns: [/\bM\.D\.(?=[\s,)]|$)/g, /\bJ\.D\.(?=[\s,)]|$)/g, /\bDDS\b/g, /\bDVM\b/g, /\b(?:MD|JD)(?= degree\b)/g, /\bjuris doctor\b/gi, /\bdoctor of medicine\b/gi] },
];

/** Words that end or form a job title. */
export const ROLE_NOUNS = [
  'engineer', 'engineers', 'developer', 'developers', 'programmer', 'manager', 'analyst', 'intern', 'designer', 'architect', 'scientist',
  'consultant', 'specialist', 'coordinator', 'director', 'administrator', 'assistant', 'associate', 'officer', 'representative',
  'technician', 'nurse', 'teacher', 'instructor', 'professor', 'researcher', 'accountant', 'advisor', 'adviser', 'agent', 'clerk',
  'supervisor', 'head', 'chief', 'president', 'vp', 'founder', 'cofounder', 'co-founder', 'owner', 'partner', 'editor', 'writer',
  'producer', 'strategist', 'recruiter', 'planner', 'operator', 'therapist', 'pharmacist', 'physician', 'attorney', 'paralegal',
  'tutor', 'fellow', 'trainee', 'apprentice', 'contractor', 'freelancer', 'executive', 'lead', 'leader', 'principal', 'owner',
  'cashier', 'barista', 'server', 'chef', 'cook', 'driver', 'mechanic', 'electrician', 'lecturer', 'counselor', 'librarian',
  'auditor', 'controller', 'bookkeeper', 'buyer', 'marketer', 'sre', 'devops', 'tester', 'hygienist', 'paramedic', 'emt',
];

export const SENIORITY_WORDS = [
  'senior', 'sr', 'sr.', 'lead', 'principal', 'staff', 'chief', 'head', 'director', 'vp', 'vice president', 'junior', 'jr', 'jr.',
  'associate', 'distinguished', 'executive', 'managing', 'group', 'assistant', 'deputy', 'founding',
];

/** Words that mark an organisation name. */
export const ORG_WORDS = [
  'inc', 'inc.', 'llc', 'ltd', 'ltd.', 'corp', 'corp.', 'corporation', 'company', 'co.', 'labs', 'lab', 'laboratories', 'technologies',
  'technology', 'systems', 'solutions', 'group', 'partners', 'university', 'college', 'school', 'institute', 'academy', 'hospital',
  'clinic', 'health', 'healthcare', 'bank', 'capital', 'ventures', 'studio', 'studios', 'agency', 'foundation', 'association',
  'center', 'centre', 'department', 'consulting', 'software', 'networks', 'media', 'holdings', 'industries', 'enterprises',
  'international', 'global', 'services', 'analytics', 'robotics', 'pharmaceuticals', 'therapeutics', 'motors', 'airlines', 'insurance',
];

export const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Section headings -> the section kind jobleft maps them to. Anything else is "custom" and is reported. */
export const SECTION_ALIASES: Readonly<Record<string, 'summary' | 'experience' | 'education' | 'skills' | 'projects' | 'certifications'>> = {
  summary: 'summary', 'professional summary': 'summary', 'career summary': 'summary', 'executive summary': 'summary', profile: 'summary',
  'professional profile': 'summary', 'personal profile': 'summary', about: 'summary', 'about me': 'summary', objective: 'summary',
  'career objective': 'summary', overview: 'summary', 'personal statement': 'summary', 'summary of qualifications': 'summary',
  'qualifications summary': 'summary', 'professional overview': 'summary',
  experience: 'experience', 'work experience': 'experience', 'professional experience': 'experience', employment: 'experience',
  'employment history': 'experience', 'work history': 'experience', 'career history': 'experience', 'relevant experience': 'experience',
  'professional background': 'experience', 'industry experience': 'experience', 'technical experience': 'experience',
  'research experience': 'experience', internships: 'experience', 'internship experience': 'experience', 'experience and internships': 'experience',
  'work and leadership experience': 'experience', 'professional history': 'experience', 'employment experience': 'experience',
  education: 'education', 'academic background': 'education', 'education and training': 'education', 'educational background': 'education',
  'academic history': 'education', academics: 'education', 'education history': 'education',
  skills: 'skills', 'technical skills': 'skills', 'key skills': 'skills', 'core skills': 'skills', 'core competencies': 'skills',
  competencies: 'skills', 'areas of expertise': 'skills', expertise: 'skills', technologies: 'skills', 'technical proficiencies': 'skills',
  'skills and tools': 'skills', 'tools and technologies': 'skills', 'languages and technologies': 'skills', 'tech stack': 'skills',
  'skills and technologies': 'skills', 'relevant skills': 'skills', 'professional skills': 'skills', 'skills summary': 'skills',
  'technical expertise': 'skills', 'skills and abilities': 'skills', tools: 'skills', 'software skills': 'skills', 'computer skills': 'skills',
  projects: 'projects', 'personal projects': 'projects', 'selected projects': 'projects', 'academic projects': 'projects',
  'key projects': 'projects', 'side projects': 'projects', 'technical projects': 'projects', 'relevant projects': 'projects', portfolio: 'projects',
  certifications: 'certifications', certificates: 'certifications', licenses: 'certifications', licences: 'certifications',
  'licenses and certifications': 'certifications', 'certifications and licenses': 'certifications', credentials: 'certifications',
  'professional certifications': 'certifications', licensure: 'certifications', 'certifications and training': 'certifications',
  'licenses and certificates': 'certifications', 'licences and certifications': 'certifications',
};

/** Other headings people use; they become custom sections, kept word for word and reported as not read into fields. */
export const KNOWN_OTHER_HEADINGS = new Set([
  'publications', 'papers', 'research', 'awards', 'honors', 'honours', 'awards and honors', 'honors and awards', 'achievements',
  'accomplishments', 'volunteer', 'volunteering', 'volunteer experience', 'community involvement', 'community service', 'leadership',
  'leadership experience', 'activities', 'extracurricular activities', 'extracurriculars', 'interests', 'hobbies', 'hobbies and interests',
  'languages', 'references', 'affiliations', 'memberships', 'professional affiliations', 'presentations', 'conferences', 'patents',
  'courses', 'coursework', 'relevant coursework', 'training', 'military service', 'additional information', 'other', 'links',
  'profiles', 'social profiles', 'teaching', 'teaching experience', 'grants', 'service', 'organizations', 'clubs', 'speaking',
]);

/** Capitalised words that are not facts (salutations, closing words, calendar words, common acronyms). */
export const ORDINARY_CAPITALISED = new Set([
  'i', "i'm", "i've", "i'd", "i'll", 'dear', 'hiring', 'manager', 'team', 'sincerely', 'regards', 'best', 'thank', 'thanks', 'kind',
  'warm', 'respectfully', 'yours', 'cordially', 'hello', 'hi', 'to', 'whom', 'it', 'may', 'concern', 'mr', 'ms', 'mrs', 'mx',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'june',
  'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept',
  'oct', 'nov', 'dec', 'present', 'current', 'english', 'api', 'apis', 'ui', 'url', 'urls', 'pdf', 'id', 'ids', 'ok', 'faq', 'q1', 'q2',
  'q3', 'q4', 'summary', 'experience', 'education', 'skills', 'projects', 'certifications', 'profile', 'objective', 'resume',
  'cover', 'letter', 'references', 'available', 'upon', 'request', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'with',
  'my', 'our', 'your', 'this', 'that', 'these', 'those', 'as', 'at', 'by', 'from', 'about', 'role', 'position', 'opportunity',
]);
