// ============================================================
// Help texts of the portal: what a page is for, how to set it up, and
// the outside pages a setup needs (where an API key is created, where
// Meta keeps the WhatsApp credentials).
//
// Written here rather than in the message files because every topic is
// in two languages side by side (English and Hindi), and the reader
// switches between them in the help window itself.
//
// Pure — safe to import from server and client code.
// ============================================================

export type HelpLang = 'en' | 'hi'

type Text = Record<HelpLang, string>

export interface HelpLink {
  label: Text
  /** An outside page (https://…) or a page of the portal (/settings?tab=…). */
  url: string
}

export interface HelpTopic {
  title: Text
  intro: Text
  steps: Record<HelpLang, string[]>
  links?: HelpLink[]
}

/** Where each AI provider hands out API keys. */
export const AI_KEY_PAGES = {
  openai: { name: 'OpenAI (ChatGPT)', url: 'https://platform.openai.com/api-keys' },
  anthropic: { name: 'Anthropic (Claude)', url: 'https://console.anthropic.com/settings/keys' },
  gemini: { name: 'Google Gemini', url: 'https://aistudio.google.com/app/apikey' },
} as const

export type AiKeyProvider = keyof typeof AI_KEY_PAGES

export const META_APPS_URL = 'https://developers.facebook.com/apps'
export const META_SYSTEM_USERS_URL = 'https://business.facebook.com/settings/system-users'
export const META_DOCS_URL = 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started'

const aiKeyLinks: HelpLink[] = [
  { label: { en: 'Create an OpenAI (ChatGPT) key', hi: 'OpenAI (ChatGPT) की key बनाएं' }, url: AI_KEY_PAGES.openai.url },
  { label: { en: 'Create an Anthropic (Claude) key', hi: 'Anthropic (Claude) की key बनाएं' }, url: AI_KEY_PAGES.anthropic.url },
  { label: { en: 'Create a Google Gemini key', hi: 'Google Gemini की key बनाएं' }, url: AI_KEY_PAGES.gemini.url },
]

export const HELP_TOPICS = {
  dashboard: {
    title: { en: 'Dashboard', hi: 'डैशबोर्ड' },
    intro: {
      en: 'A summary of your business on WhatsApp: chats, contacts, deals and appointments at a glance.',
      hi: 'WhatsApp पर आपके काम का सार: चैट, कॉन्टैक्ट, डील और अपॉइंटमेंट एक नज़र में।',
    },
    steps: {
      en: [
        'Pick a WhatsApp number at the top to see the figures of that number only.',
        'Click a card to open the module behind it.',
        'Cards appear only for the modules you use. The appointments calendar shows once booking in chat is switched on.',
      ],
      hi: [
        'ऊपर से WhatsApp नंबर चुनें, तब सिर्फ़ उसी नंबर के आंकड़े दिखेंगे।',
        'किसी कार्ड पर क्लिक करके उसका मॉड्यूल खोलें।',
        'कार्ड सिर्फ़ उन्हीं मॉड्यूल के दिखते हैं जो आप इस्तेमाल करते हैं। अपॉइंटमेंट कैलेंडर तब दिखता है जब चैट में बुकिंग चालू हो।',
      ],
    },
    links: [{ label: { en: 'Connect a WhatsApp number', hi: 'WhatsApp नंबर जोड़ें' }, url: '/settings?tab=whatsapp' }],
  },
  inbox: {
    title: { en: 'Inbox', hi: 'इनबॉक्स' },
    intro: {
      en: 'Every WhatsApp chat of your numbers in one place, for the whole team.',
      hi: 'आपके सभी WhatsApp नंबरों की हर चैट एक जगह, पूरी टीम के लिए।',
    },
    steps: {
      en: [
        'Connect a WhatsApp number first (Settings → WhatsApp).',
        'Open a chat on the left and type your reply at the bottom.',
        'Use the quick-reply button beside the reply box to insert a saved answer.',
        'Assign a chat to a team member, add tags, or close it when the work is done.',
        'On a Business API number a plain message can be sent only within 24 hours of the customer\'s last message; after that, send an approved template.',
      ],
      hi: [
        'पहले WhatsApp नंबर जोड़ें (Settings → WhatsApp)।',
        'बाईं ओर से चैट खोलें और नीचे जवाब लिखें।',
        'जवाब के बॉक्स के पास वाले quick-reply बटन से सेव किया हुआ जवाब डालें।',
        'चैट किसी टीम सदस्य को सौंपें, टैग लगाएं, या काम पूरा होने पर बंद करें।',
        'Business API नंबर पर सादा मैसेज ग्राहक के आख़िरी मैसेज के 24 घंटे के अंदर ही जाता है; उसके बाद approved template भेजें।',
      ],
    },
    links: [
      { label: { en: 'Connect a WhatsApp number', hi: 'WhatsApp नंबर जोड़ें' }, url: '/settings?tab=whatsapp' },
      { label: { en: 'Quick replies', hi: 'Quick replies' }, url: '/settings?tab=quick-replies' },
    ],
  },
  notifications: {
    title: { en: 'Notifications', hi: 'नोटिफ़िकेशन' },
    intro: {
      en: 'What needs your attention: new chats, chats assigned to you and mentions.',
      hi: 'जिन बातों पर आपका ध्यान चाहिए: नई चैट, आपको सौंपी गई चैट और mentions।',
    },
    steps: {
      en: [
        'Click a notification to open its chat.',
        'Mark notifications read to clear the count in the menu.',
        'For alerts on your computer, switch on browser notifications in Settings → Your profile.',
      ],
      hi: [
        'नोटिफ़िकेशन पर क्लिक करके उसकी चैट खोलें।',
        'पढ़ा हुआ मार्क करें, तब मेनू की गिनती हट जाएगी।',
        'कंप्यूटर पर अलर्ट के लिए Settings → Your profile में browser notifications चालू करें।',
      ],
    },
    links: [{ label: { en: 'Your profile', hi: 'आपकी प्रोफ़ाइल' }, url: '/settings?tab=profile' }],
  },
  contacts: {
    title: { en: 'Contacts', hi: 'कॉन्टैक्ट' },
    intro: {
      en: 'Your customer list, with tags, custom fields and wishes such as birthdays.',
      hi: 'आपके ग्राहकों की सूची, टैग, custom fields और जन्मदिन जैसी wishes के साथ।',
    },
    steps: {
      en: [
        'Add a contact by hand, import an Excel or CSV file, or sync from your phone or WhatsApp.',
        'Open a contact to edit its details, tags and wishes.',
        'Use tags to group customers; a broadcast can be sent to a tag.',
        'A phone number needs its country code, for example 91 for India.',
      ],
      hi: [
        'कॉन्टैक्ट हाथ से जोड़ें, Excel या CSV फ़ाइल import करें, या फ़ोन/WhatsApp से sync करें।',
        'कॉन्टैक्ट खोलकर उसकी जानकारी, टैग और wishes बदलें।',
        'टैग से ग्राहकों के समूह बनाएं; broadcast किसी टैग को भेजा जा सकता है।',
        'फ़ोन नंबर में country code ज़रूरी है, जैसे भारत के लिए 91।',
      ],
    },
    links: [{ label: { en: 'Fields & tags', hi: 'Fields और टैग' }, url: '/settings?tab=fields' }],
  },
  pipelines: {
    title: { en: 'Pipelines', hi: 'पाइपलाइन' },
    intro: {
      en: 'Follow each deal from the first enquiry to won or lost.',
      hi: 'हर डील को पहली पूछताछ से लेकर जीत या हार तक ट्रैक करें।',
    },
    steps: {
      en: [
        'Create a pipeline and name its stages, for example New, Quoted, Won.',
        'Add a deal with the contact and its value.',
        'Drag a deal to the next stage as it moves forward.',
        'Set your currency in Settings → Deals & currency.',
      ],
      hi: [
        'पाइपलाइन बनाएं और उसके stages के नाम रखें, जैसे New, Quoted, Won।',
        'कॉन्टैक्ट और रक़म के साथ डील जोड़ें।',
        'डील आगे बढ़े तो उसे खींचकर अगले stage में रखें।',
        'अपनी currency Settings → Deals & currency में चुनें।',
      ],
    },
    links: [{ label: { en: 'Deals & currency', hi: 'Deals और currency' }, url: '/settings?tab=deals' }],
  },
  broadcasts: {
    title: { en: 'Broadcasts', hi: 'ब्रॉडकास्ट' },
    intro: {
      en: 'Send one message to many contacts at once.',
      hi: 'एक मैसेज एक साथ कई कॉन्टैक्ट को भेजें।',
    },
    steps: {
      en: [
        'Broadcasts go out from a Business API number with a template Meta has approved.',
        'Create the template first in Settings → Templates and wait for approval.',
        'Choose who gets it: a tag, selected contacts or a CSV file.',
        'Send now or schedule it, then follow delivered, read and failed counts here.',
        'A WhatsApp Web number cannot send broadcasts.',
      ],
      hi: [
        'ब्रॉडकास्ट Business API नंबर से, Meta के approved template के साथ जाता है।',
        'पहले Settings → Templates में template बनाएं और approval का इंतज़ार करें।',
        'चुनें किसे भेजना है: कोई टैग, चुने हुए कॉन्टैक्ट या CSV फ़ाइल।',
        'अभी भेजें या समय तय करें, फिर delivered, read और failed की गिनती यहीं देखें।',
        'WhatsApp Web नंबर से ब्रॉडकास्ट नहीं भेजा जा सकता।',
      ],
    },
    links: [{ label: { en: 'Templates', hi: 'Templates' }, url: '/settings?tab=templates' }],
  },
  posts: {
    title: { en: 'Posts', hi: 'पोस्ट' },
    intro: {
      en: 'Make one post and send it to several places: WhatsApp Status, your contacts, and a copy in Google Drive.',
      hi: 'एक पोस्ट बनाएं और कई जगह भेजें: WhatsApp Status, आपके कॉन्टैक्ट, और Google Drive में एक कॉपी।',
    },
    steps: {
      en: [
        'Choose the WhatsApp number the post goes out from.',
        'Write the text and add an image if you want one (PNG, JPEG or WebP, up to 5 MB).',
        'Tick where it should go, then send.',
        'Earlier posts of that number are listed below.',
      ],
      hi: [
        'वह WhatsApp नंबर चुनें जिससे पोस्ट जाएगी।',
        'टेक्स्ट लिखें और चाहें तो इमेज जोड़ें (PNG, JPEG या WebP, 5 MB तक)।',
        'टिक करें कि पोस्ट कहां जानी है, फिर भेजें।',
        'उस नंबर की पुरानी पोस्ट नीचे दिखती हैं।',
      ],
    },
  },
  appointments: {
    title: { en: 'Appointments', hi: 'अपॉइंटमेंट' },
    intro: {
      en: 'Customers book on WhatsApp in their own words, at any hour of any day, and you manage every booking here. Each number has its own diary.',
      hi: 'ग्राहक WhatsApp पर अपने शब्दों में, दिन-रात किसी भी समय बुकिंग करते हैं, और आप हर बुकिंग यहां संभालते हैं। हर नंबर की अपनी डायरी है।',
    },
    steps: {
      en: [
        'Open the Settings tab and choose the WhatsApp number.',
        'Set your working hours, the length of a slot and how many days ahead customers may book.',
        'Add your AI key in AI Agents → Setup: the assistant needs it to understand customers.',
        'Switch booking in chat on. The assistant answers round the clock; it only offers slots inside your working hours.',
        'If the number is also your personal WhatsApp, switch on "Answer only when the customer uses a wake word" under "When to answer".',
        'Reminders can be sent before each appointment; on a Business API number choose an approved template for them.',
      ],
      hi: [
        'Settings टैब खोलें और WhatsApp नंबर चुनें।',
        'काम के घंटे, एक slot की अवधि और कितने दिन आगे तक बुकिंग हो सकती है, यह तय करें।',
        'AI Agents → Setup में अपनी AI key डालें: assistant को ग्राहक की बात समझने के लिए यह चाहिए।',
        'चैट में बुकिंग चालू करें। Assistant चौबीसों घंटे जवाब देता है; slot सिर्फ़ आपके काम के घंटों के अंदर देता है।',
        'अगर नंबर आपका निजी WhatsApp भी है, तो "When to answer" में "Answer only when the customer uses a wake word" चालू करें।',
        'हर अपॉइंटमेंट से पहले reminder भेजा जा सकता है; Business API नंबर पर इसके लिए approved template चुनें।',
      ],
    },
    links: [{ label: { en: 'AI Agents (add your AI key)', hi: 'AI Agents (AI key डालें)' }, url: '/agents' }],
  },
  events: {
    title: { en: 'Events', hi: 'इवेंट' },
    intro: {
      en: 'Entry passes with a QR code: customers ask for them on WhatsApp, pay to your UPI ID, and you scan them at the gate.',
      hi: 'QR code वाले entry pass: ग्राहक WhatsApp पर मांगते हैं, आपकी UPI ID पर भुगतान करते हैं, और आप गेट पर scan करते हैं।',
    },
    steps: {
      en: [
        'Create an event with its date, place and pass types. Each type has its own price and number of places; price 0 means free.',
        'Enter your UPI ID so the chat can send a payment QR with the amount filled in.',
        'Switch booking in chat on, or issue passes yourself from the Issue pass tab.',
        'Check the payment screenshot the customer sends back, then approve the pass.',
        'At the gate, scan the QR code of each pass to mark it used.',
      ],
      hi: [
        'इवेंट बनाएं: तारीख़, जगह और pass के प्रकार। हर प्रकार की अपनी क़ीमत और सीटें होती हैं; क़ीमत 0 मतलब मुफ़्त।',
        'अपनी UPI ID डालें ताकि चैट रक़म भरा हुआ payment QR भेज सके।',
        'चैट में बुकिंग चालू करें, या Issue pass टैब से खुद pass जारी करें।',
        'ग्राहक का भेजा हुआ payment screenshot जांचें, फिर pass approve करें।',
        'गेट पर हर pass का QR code scan करके उसे used मार्क करें।',
      ],
    },
  },
  service: {
    title: { en: 'Service Today', hi: 'Service Today' },
    intro: {
      en: 'A record of every service visit. The customer gets a WhatsApp confirmation, and a reminder the day before and on the day of the next visit.',
      hi: 'हर service visit का रिकॉर्ड। ग्राहक को WhatsApp पर पुष्टि मिलती है, और अगली visit से एक दिन पहले और उसी दिन reminder।',
    },
    steps: {
      en: [
        'Fill in your business name and address once; they appear in the messages customers get.',
        'Add a visit: the customer, what was done and the date of the next visit.',
        'Choose the time of day reminders go out.',
        'It works on WhatsApp Web numbers.',
      ],
      hi: [
        'एक बार अपने business का नाम और पता भरें; ये ग्राहकों को जाने वाले मैसेज में दिखते हैं।',
        'Visit जोड़ें: ग्राहक, क्या काम हुआ और अगली visit की तारीख़।',
        'दिन का वह समय चुनें जब reminder जाएंगे।',
        'यह WhatsApp Web नंबरों पर चलता है।',
      ],
    },
  },
  automations: {
    title: { en: 'Automations', hi: 'ऑटोमेशन' },
    intro: {
      en: 'Rules that act on their own: "when this happens, do that".',
      hi: 'अपने आप चलने वाले नियम: "जब यह हो, तो वह करो"।',
    },
    steps: {
      en: [
        'Start from a ready-made automation or create your own.',
        'Choose the trigger, for example a new message, a keyword or a new contact.',
        'Add the actions: send a message, add a tag, assign the chat, wait.',
        'Switch the automation on. Test it by writing to your number from another phone.',
      ],
      hi: [
        'तैयार automation से शुरू करें या अपना बनाएं।',
        'Trigger चुनें, जैसे नया मैसेज, कोई keyword या नया कॉन्टैक्ट।',
        'Actions जोड़ें: मैसेज भेजना, टैग लगाना, चैट सौंपना, रुकना।',
        'Automation चालू करें। दूसरे फ़ोन से अपने नंबर पर लिखकर जांचें।',
      ],
    },
  },
  flows: {
    title: { en: 'Flows', hi: 'फ़्लो' },
    intro: {
      en: 'A guided conversation with buttons and questions, drawn as a diagram.',
      hi: 'बटन और सवालों वाली guided बातचीत, जिसे चित्र की तरह बनाया जाता है।',
    },
    steps: {
      en: [
        'Start from a ready-made flow or create a blank one.',
        'Add steps (message, question, buttons) and connect them in order.',
        'Choose what starts the flow, for example a keyword.',
        'Publish it, then test by writing to your number from another phone.',
        'On a WhatsApp Web number buttons are sent as numbered text.',
      ],
      hi: [
        'तैयार flow से शुरू करें या ख़ाली flow बनाएं।',
        'Steps जोड़ें (मैसेज, सवाल, बटन) और उन्हें क्रम में जोड़ें।',
        'चुनें flow किससे शुरू होगा, जैसे कोई keyword।',
        'Publish करें, फिर दूसरे फ़ोन से अपने नंबर पर लिखकर जांचें।',
        'WhatsApp Web नंबर पर बटन नंबर वाले टेक्स्ट की तरह जाते हैं।',
      ],
    },
  },
  agents: {
    title: { en: 'AI Agents', hi: 'AI एजेंट' },
    intro: {
      en: 'An AI assistant that answers customers with your own AI key. You pay the AI company directly for what it uses.',
      hi: 'आपकी अपनी AI key से ग्राहकों को जवाब देने वाला AI assistant। इस्तेमाल का भुगतान आप सीधे AI कंपनी को करते हैं।',
    },
    steps: {
      en: [
        'Open the Setup tab and choose a provider: OpenAI (ChatGPT), Anthropic (Claude) or Google Gemini.',
        'Create an API key on the provider\'s page (links below), copy it and paste it into the API key box.',
        'Click Test key, then Save.',
        'Describe your business in the Business context box and add knowledge the AI may answer from.',
        'Try it in the Playground before switching automatic replies on.',
      ],
      hi: [
        'Setup टैब खोलें और provider चुनें: OpenAI (ChatGPT), Anthropic (Claude) या Google Gemini।',
        'Provider के पेज पर API key बनाएं (लिंक नीचे हैं), copy करें और API key बॉक्स में paste करें।',
        'Test key दबाएं, फिर Save करें।',
        'Business context बॉक्स में अपने business के बारे में लिखें और वह जानकारी जोड़ें जिससे AI जवाब दे।',
        'Automatic replies चालू करने से पहले Playground में आज़माएं।',
      ],
    },
    links: aiKeyLinks,
  },
  data: {
    title: { en: 'Data tables', hi: 'डेटा टेबल' },
    intro: {
      en: 'Spreadsheets your AI agent, flows and automations can answer from, such as a price list or stock.',
      hi: 'ऐसी spreadsheets जिनसे आपका AI agent, flows और automations जवाब दे सकें, जैसे price list या stock।',
    },
    steps: {
      en: [
        'Upload an Excel or CSV file, or paste a Google Sheet link.',
        'For a Google Sheet: in Google Sheets choose Share, set General access to "Anyone with the link" (Viewer), then paste the link here.',
        'Every sheet becomes a table you can edit here. Use Refresh to pull the latest data.',
        'Choose the table in the AI Agent, a flow or an automation.',
      ],
      hi: [
        'Excel या CSV फ़ाइल upload करें, या Google Sheet का लिंक paste करें।',
        'Google Sheet के लिए: Google Sheets में Share चुनें, General access को "Anyone with the link" (Viewer) करें, फिर लिंक यहां paste करें।',
        'हर sheet एक टेबल बन जाती है जिसे आप यहां बदल सकते हैं। नया डेटा लाने के लिए Refresh दबाएं।',
        'टेबल को AI Agent, किसी flow या automation में चुनें।',
      ],
    },
    links: [{ label: { en: 'Open Google Sheets', hi: 'Google Sheets खोलें' }, url: 'https://docs.google.com/spreadsheets' }],
  },
  plans: {
    title: { en: 'Plans', hi: 'प्लान' },
    intro: {
      en: 'What each subscription includes. Your own plan is marked.',
      hi: 'हर subscription में क्या शामिल है। आपका अपना प्लान मार्क किया हुआ है।',
    },
    steps: {
      en: [
        'A module with a lock in the menu is outside your plan: you can open and read it, but not change anything in it.',
        'The plan also sets how many WhatsApp Web numbers and team members you may have.',
        'To change your plan, write to llc.sirohi.in@gmail.com.',
      ],
      hi: [
        'मेनू में ताले वाला मॉड्यूल आपके प्लान से बाहर है: उसे खोलकर देख सकते हैं, पर उसमें कुछ बदल नहीं सकते।',
        'प्लान यह भी तय करता है कि कितने WhatsApp Web नंबर और टीम सदस्य हो सकते हैं।',
        'प्लान बदलने के लिए llc.sirohi.in@gmail.com पर लिखें।',
      ],
    },
    links: [{ label: { en: 'Email support', hi: 'Support को email करें' }, url: 'mailto:llc.sirohi.in@gmail.com' }],
  },
  aedaForms: {
    title: { en: 'AEDA Forms', hi: 'AEDA Forms' },
    intro: {
      en: 'A form builder with roles, workflow stages and a workflow for every button. Build a form, publish it, fill it in and follow every submission.',
      hi: 'Roles, workflow stages और हर बटन के लिए workflow वाला फ़ॉर्म बिल्डर। फ़ॉर्म बनाएं, publish करें, भरें और हर submission पर नज़र रखें।',
    },
    steps: {
      en: [
        'Create a project, then a form inside it. Each form has two entries: Edit / Design and Summary.',
        'Form Design tab: drag fields, sections and buttons onto the canvas; click one to set its label, key, width, default value, validation and the roles or stages that may see or edit it.',
        'Create Roles, Workflow Stages and Email templates in the same tab.',
        'Form Workflow tab: pick a button and connect nodes in order, for example Validate Required → Set Workflow Stage → Save to Database → Send Email → Popup Dialog.',
        'Preview / Test tab: try the working design with a role and a stage. Nothing is saved or sent.',
        'Save, then Publish. A published form is locked; Unpublish to edit. Every publish is kept as a version you can restore from the Database tab.',
        'Summary page: see submissions, choose columns, open one to edit, download its PDF. "New Form" opens the form to fill in.',
        'Database tab: search and edit submissions, see each run trace, the email log, and Extract to CSV or Excel (now or on a schedule).',
        'To send real emails, open Settings (top right of the Projects page) and add a SendGrid key or an SMTP account, then use "Send a test email".',
      ],
      hi: [
        'Project बनाएं, फिर उसके अंदर फ़ॉर्म। हर फ़ॉर्म के दो रास्ते हैं: Edit / Design और Summary।',
        'Form Design टैब: fields, sections और buttons को canvas पर खींचें; किसी पर क्लिक करके उसका label, key, चौड़ाई, default value, validation और कौन से roles या stages उसे देख या बदल सकते हैं, यह तय करें।',
        'इसी टैब में Roles, Workflow Stages और Email templates बनाएं।',
        'Form Workflow टैब: बटन चुनें और nodes को क्रम में जोड़ें, जैसे Validate Required → Set Workflow Stage → Save to Database → Send Email → Popup Dialog।',
        'Preview / Test टैब: किसी role और stage के साथ working design आज़माएं। कुछ भी save या send नहीं होता।',
        'Save करें, फिर Publish। Publish किया हुआ फ़ॉर्म lock रहता है; बदलने के लिए Unpublish करें। हर publish एक version के रूप में रहता है जिसे Database टैब से restore कर सकते हैं।',
        'Summary page: submissions देखें, columns चुनें, किसी को खोलकर बदलें, उसका PDF download करें। "New Form" से फ़ॉर्म भरने के लिए खुलता है।',
        'Database टैब: submissions खोजें और बदलें, हर run का trace और email log देखें, और CSV या Excel में Extract करें (अभी या तय समय पर)।',
        'असली email भेजने के लिए Settings (Projects पेज के ऊपर दाईं ओर) खोलें और SendGrid key या SMTP account जोड़ें, फिर "Send a test email" आज़माएं।',
      ],
    },
  },
  settings: {
    title: { en: 'Settings', hi: 'सेटिंग्स' },
    intro: {
      en: 'Everything you set up once: your WhatsApp numbers, team, templates and how the portal looks.',
      hi: 'वह सब जो एक बार सेट करना होता है: WhatsApp नंबर, टीम, templates और portal का रूप।',
    },
    steps: {
      en: [
        'New here? Start with WhatsApp: connect your first number.',
        'Then invite your team in Team members.',
        'Pick a section on the left; the Help button explains whichever section is open.',
      ],
      hi: [
        'नए हैं? WhatsApp से शुरू करें: अपना पहला नंबर जोड़ें।',
        'फिर Team members में अपनी टीम को बुलाएं।',
        'बाईं ओर से section चुनें; Help बटन खुले हुए section के बारे में बताता है।',
      ],
    },
    links: [{ label: { en: 'Connect a WhatsApp number', hi: 'WhatsApp नंबर जोड़ें' }, url: '/settings?tab=whatsapp' }],
  },
  profile: {
    title: { en: 'Your profile', hi: 'आपकी प्रोफ़ाइल' },
    intro: { en: 'Your name, photo and alerts.', hi: 'आपका नाम, फ़ोटो और अलर्ट।' },
    steps: {
      en: [
        'Change your name or photo and save.',
        'Switch on browser notifications to get an alert on this computer for new customer messages; allow it when the browser asks.',
      ],
      hi: [
        'अपना नाम या फ़ोटो बदलें और save करें।',
        'नए मैसेज का अलर्ट इस कंप्यूटर पर पाने के लिए browser notifications चालू करें; browser पूछे तो Allow दबाएं।',
      ],
    },
  },
  security: {
    title: { en: 'Login & security', hi: 'लॉगिन और सुरक्षा' },
    intro: { en: 'Your password and the devices signed in to your account.', hi: 'आपका पासवर्ड और वे डिवाइस जिनसे आप sign in हैं।' },
    steps: {
      en: [
        'A password needs at least 8 characters with a small letter, a capital letter, a number and a symbol.',
        'Under Sessions, sign out a device you do not recognise.',
        'Never share your password; invite team members instead.',
      ],
      hi: [
        'पासवर्ड में कम से कम 8 अक्षर हों: छोटा अक्षर, बड़ा अक्षर, अंक और चिह्न।',
        'Sessions में, जो डिवाइस आप नहीं पहचानते उसे sign out करें।',
        'पासवर्ड किसी को न दें; इसके बजाय टीम सदस्य को invite करें।',
      ],
    },
  },
  appearance: {
    title: { en: 'Appearance', hi: 'रूप' },
    intro: { en: 'Light or dark mode and the accent colour, for you only.', hi: 'Light या dark mode और रंग, सिर्फ़ आपके लिए।' },
    steps: {
      en: ['Choose light, dark or the same as your device.', 'Pick an accent colour. It changes at once and only on your screen.'],
      hi: ['Light, dark या अपने डिवाइस जैसा चुनें।', 'रंग चुनें। यह तुरंत और सिर्फ़ आपकी स्क्रीन पर बदलता है।'],
    },
  },
  branding: {
    title: { en: 'Business branding', hi: 'Business branding' },
    intro: {
      en: 'Show your own business name and logo at the top of the portal.',
      hi: 'Portal के ऊपर अपने business का नाम और logo दिखाएं।',
    },
    steps: {
      en: ['Type your business name (up to 40 characters).', 'Upload your logo.', 'Switch branding on and save. Your whole team sees it.'],
      hi: ['अपने business का नाम लिखें (40 अक्षर तक)।', 'अपना logo upload करें।', 'Branding चालू करके save करें। आपकी पूरी टीम को यह दिखेगा।'],
    },
  },
  whatsapp: {
    title: { en: 'Connect WhatsApp', hi: 'WhatsApp जोड़ें' },
    intro: {
      en: 'There are two ways to connect a number. WhatsApp Web is the quick one: scan a QR code with your phone. The Business API is the official one from Meta, needed for templates and broadcasts.',
      hi: 'नंबर जोड़ने के दो तरीक़े हैं। WhatsApp Web आसान है: फ़ोन से QR code scan करें। Business API Meta का official तरीक़ा है, जो templates और broadcasts के लिए ज़रूरी है।',
    },
    steps: {
      en: [
        'WhatsApp Web: click "Link WhatsApp Web", give the number a name and send the request.',
        'When the request is approved, a QR code appears here. On the phone open WhatsApp → Settings (or ⋮) → Linked devices → Link a device, and scan it.',
        'Keep that phone connected to the internet.',
        'Business API: click "Add Business API number", then paste the Phone Number ID, the WhatsApp Business Account ID and the access token from Meta, and set the webhook in Meta.',
        'Unsure? Start with WhatsApp Web. You can add a Business API number later.',
      ],
      hi: [
        'WhatsApp Web: "Link WhatsApp Web" दबाएं, नंबर को नाम दें और request भेजें।',
        'Request approve होने पर यहां QR code दिखेगा। फ़ोन में WhatsApp → Settings (या ⋮) → Linked devices → Link a device खोलकर scan करें।',
        'उस फ़ोन को internet से जुड़ा रखें।',
        'Business API: "Add Business API number" दबाएं, फिर Meta से मिला Phone Number ID, WhatsApp Business Account ID और access token paste करें, और Meta में webhook सेट करें।',
        'समझ न आए तो WhatsApp Web से शुरू करें। Business API नंबर बाद में जोड़ सकते हैं।',
      ],
    },
    links: [
      { label: { en: 'Meta: my apps', hi: 'Meta: मेरे apps' }, url: META_APPS_URL },
      { label: { en: 'Meta: system users (permanent token)', hi: 'Meta: system users (permanent token)' }, url: META_SYSTEM_USERS_URL },
      { label: { en: 'Meta WhatsApp API guide', hi: 'Meta WhatsApp API guide' }, url: META_DOCS_URL },
    ],
  },
  whatsappWeb: {
    title: { en: 'Connect with WhatsApp Web', hi: 'WhatsApp Web से जोड़ें' },
    intro: {
      en: 'The quick way: your number is linked by scanning a QR code, just like WhatsApp Web on a computer. It works with the normal WhatsApp or WhatsApp Business app. Good for chatting, appointments and reminders. It cannot send templates or broadcasts.',
      hi: 'आसान तरीक़ा: QR code scan करके आपका नंबर जुड़ता है, बिल्कुल कंप्यूटर के WhatsApp Web की तरह। यह सामान्य WhatsApp या WhatsApp Business app दोनों से चलता है। चैट, अपॉइंटमेंट और reminder के लिए अच्छा है। इससे templates या broadcasts नहीं भेजे जा सकते।',
    },
    steps: {
      en: [
        'Keep the phone with that WhatsApp number in your hand, with internet on.',
        'Click "Link WhatsApp Web" below, type a name for the number (for example "Shop number") and click "Request number".',
        'Read the note about the limits and click "I understand, send request".',
        'Wait for approval. The card shows "Pending approval"; you do not need to refresh the page.',
        'When it is approved, a QR code appears on this page.',
        'On the phone open WhatsApp. Android: tap ⋮ (three dots) → Linked devices. iPhone: Settings → Linked devices.',
        'Tap "Link a device" and point the phone\'s camera at the QR code on this screen. The code changes every 20 seconds; the page refreshes it for you.',
        'When the card shows "Connected", send a message to this number from another phone. It appears in the Inbox.',
        'Keep the phone connected to the internet. If the number shows "Disconnected" later, open it here and scan a new QR code.',
      ],
      hi: [
        'जिस WhatsApp नंबर को जोड़ना है, वह फ़ोन हाथ में रखें और internet चालू रखें।',
        'नीचे "Link WhatsApp Web" दबाएं, नंबर का नाम लिखें (जैसे "Shop number") और "Request number" दबाएं।',
        'सीमाओं की जानकारी पढ़ें और "I understand, send request" दबाएं।',
        'Approval का इंतज़ार करें। कार्ड पर "Pending approval" दिखेगा; पेज refresh करने की ज़रूरत नहीं।',
        'Approve होते ही इसी पेज पर QR code दिखेगा।',
        'फ़ोन में WhatsApp खोलें। Android: ⋮ (तीन बिंदु) → Linked devices। iPhone: Settings → Linked devices।',
        '"Link a device" दबाएं और फ़ोन का कैमरा इस स्क्रीन के QR code पर रखें। Code हर 20 सेकंड में बदलता है; पेज उसे अपने आप नया कर देता है।',
        'कार्ड पर "Connected" दिखे तो दूसरे फ़ोन से इस नंबर पर मैसेज भेजें। वह Inbox में दिखेगा।',
        'फ़ोन को internet से जुड़ा रखें। बाद में नंबर "Disconnected" दिखे तो उसे यहां खोलकर नया QR code scan करें।',
      ],
    },
  },
  whatsappApi: {
    title: { en: 'Connect with the Business API', hi: 'Business API से जोड़ें' },
    intro: {
      en: 'The official way from Meta (Facebook). Needed for approved templates and broadcasts. It takes longer to set up, and the number cannot be used in the WhatsApp app on a phone at the same time. Meta may charge per conversation.',
      hi: 'Meta (Facebook) का official तरीक़ा। Approved templates और broadcasts के लिए ज़रूरी है। इसे सेट करने में ज़्यादा समय लगता है, और वह नंबर साथ-साथ फ़ोन के WhatsApp app में नहीं चल सकता। Meta हर conversation का शुल्क ले सकता है।',
    },
    steps: {
      en: [
        'Open developers.facebook.com (link below) and sign in with your Facebook account. Click "My Apps" → "Create App" and choose the type "Business".',
        'In the app, click "Add Product", find "WhatsApp" and click "Set up". Follow the steps to link your business and add your phone number.',
        'Go to WhatsApp → API Setup. Copy the "Phone Number ID" and the "WhatsApp Business Account ID".',
        'Make a permanent access token: Business Settings → System Users (link below) → add a system user → Generate token, with the permissions whatsapp_business_messaging and whatsapp_business_management. Copy it.',
        'Back here, paste the Phone Number ID, the WhatsApp Business Account ID and the access token into the form below.',
        'Type any word of your own in "Webhook Verify Token" (for example mybusiness123) and click "Save Configuration".',
        'In Meta, go to WhatsApp → Configuration → Webhook → Edit. Paste the "Webhook Callback URL" shown on this page and the same verify token, then click Verify and save.',
        'Still in Meta, subscribe to the webhook field "messages".',
        'Back here, click "Test API Connection". Then send a message to the number from another phone: it appears in the Inbox.',
      ],
      hi: [
        'developers.facebook.com खोलें (लिंक नीचे है) और अपने Facebook account से sign in करें। "My Apps" → "Create App" दबाएं और प्रकार "Business" चुनें।',
        'App में "Add Product" दबाएं, "WhatsApp" ढूंढें और "Set up" दबाएं। अपने business को जोड़ने और फ़ोन नंबर डालने के steps पूरे करें।',
        'WhatsApp → API Setup में जाएं। "Phone Number ID" और "WhatsApp Business Account ID" copy करें।',
        'Permanent access token बनाएं: Business Settings → System Users (लिंक नीचे है) → system user जोड़ें → Generate token, permissions whatsapp_business_messaging और whatsapp_business_management के साथ। उसे copy करें।',
        'यहां वापस आकर नीचे के फ़ॉर्म में Phone Number ID, WhatsApp Business Account ID और access token paste करें।',
        '"Webhook Verify Token" में अपना कोई भी शब्द लिखें (जैसे mybusiness123) और "Save Configuration" दबाएं।',
        'Meta में WhatsApp → Configuration → Webhook → Edit खोलें। इस पेज पर दिखा "Webhook Callback URL" और वही verify token paste करें, फिर Verify and save दबाएं।',
        'Meta में ही webhook field "messages" को subscribe करें।',
        'यहां वापस आकर "Test API Connection" दबाएं। फिर दूसरे फ़ोन से उस नंबर पर मैसेज भेजें: वह Inbox में दिखेगा।',
      ],
    },
    links: [
      { label: { en: 'Meta: my apps (create the app)', hi: 'Meta: मेरे apps (app बनाएं)' }, url: META_APPS_URL },
      { label: { en: 'Meta: system users (permanent token)', hi: 'Meta: system users (permanent token)' }, url: META_SYSTEM_USERS_URL },
      { label: { en: 'Meta WhatsApp API guide', hi: 'Meta WhatsApp API guide' }, url: META_DOCS_URL },
    ],
  },
  templates: {
    title: { en: 'Templates', hi: 'Templates' },
    intro: {
      en: 'Messages Meta approves in advance. A Business API number needs one to write first, to send a broadcast, or to write after 24 hours of silence.',
      hi: 'वे मैसेज जिन्हें Meta पहले से approve करता है। Business API नंबर को पहले लिखने, broadcast भेजने, या 24 घंटे की चुप्पी के बाद लिखने के लिए template चाहिए।',
    },
    steps: {
      en: [
        'Click New template, choose the category and language, and write the text. Use {{1}}, {{2}} for parts that change, such as a name.',
        'Submit it. Meta usually reviews within 24 hours.',
        'Once approved, use it in a broadcast, a reminder or the inbox.',
        'WhatsApp Web numbers do not use templates.',
      ],
      hi: [
        'New template दबाएं, category और भाषा चुनें, और टेक्स्ट लिखें। बदलने वाले हिस्सों के लिए {{1}}, {{2}} लिखें, जैसे नाम।',
        'Submit करें। Meta आमतौर पर 24 घंटे में जांच करता है।',
        'Approve होने पर इसे broadcast, reminder या inbox में इस्तेमाल करें।',
        'WhatsApp Web नंबर templates इस्तेमाल नहीं करते।',
      ],
    },
    links: [
      {
        label: { en: 'Meta: template rules', hi: 'Meta: template के नियम' },
        url: 'https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates',
      },
    ],
  },
  quickReplies: {
    title: { en: 'Quick replies', hi: 'Quick replies' },
    intro: { en: 'Saved answers your team sends with two clicks.', hi: 'सेव किए हुए जवाब जो आपकी टीम दो क्लिक में भेजती है।' },
    steps: {
      en: ['Add a reply with a short name and its text.', 'In the inbox, click the quick-reply button beside the reply box and pick it.'],
      hi: ['छोटे नाम और टेक्स्ट के साथ जवाब जोड़ें।', 'Inbox में जवाब के बॉक्स के पास वाला quick-reply बटन दबाकर उसे चुनें।'],
    },
  },
  inboxSettings: {
    title: { en: 'Inbox settings', hi: 'Inbox सेटिंग्स' },
    intro: { en: 'How chats behave for the whole team.', hi: 'पूरी टीम के लिए चैट कैसे चलें।' },
    steps: {
      en: ['Change a setting and save. It applies to every team member.'],
      hi: ['सेटिंग बदलें और save करें। यह हर टीम सदस्य पर लागू होती है।'],
    },
  },
  wishes: {
    title: { en: 'Wish Scheduler', hi: 'Wish Scheduler' },
    intro: {
      en: 'Sends birthday, anniversary and other wishes on their day, by itself.',
      hi: 'जन्मदिन, सालगिरह और दूसरी wishes उनके दिन अपने आप भेजता है।',
    },
    steps: {
      en: [
        'Set the wish on each contact first: Contacts → open a contact → Wish tab.',
        'Here, switch the scheduler on for the WhatsApp number that should send them.',
        'Choose how often and at what time it checks for wishes that are due.',
        'On a Business API number a wish goes out as an approved template.',
      ],
      hi: [
        'पहले हर कॉन्टैक्ट पर wish सेट करें: Contacts → कॉन्टैक्ट खोलें → Wish टैब।',
        'यहां, उस WhatsApp नंबर के लिए scheduler चालू करें जिससे wishes जानी हैं।',
        'चुनें कितनी बार और किस समय यह देय wishes जांचे।',
        'Business API नंबर पर wish approved template के रूप में जाती है।',
      ],
    },
    links: [{ label: { en: 'Contacts', hi: 'Contacts' }, url: '/contacts' }],
  },
  fields: {
    title: { en: 'Fields & tags', hi: 'Fields और टैग' },
    intro: {
      en: 'Tags group your contacts; custom fields hold extra details such as a city or a customer number.',
      hi: 'टैग आपके कॉन्टैक्ट के समूह बनाते हैं; custom fields में शहर या ग्राहक नंबर जैसी अतिरिक्त जानकारी रहती है।',
    },
    steps: {
      en: [
        'Create a tag with a name and a colour.',
        'Create a custom field with a name and a type.',
        'Fill them in on each contact. The tag "Personal" keeps a contact out of automatic answers when wake words are on.',
      ],
      hi: [
        'नाम और रंग के साथ टैग बनाएं।',
        'नाम और प्रकार के साथ custom field बनाएं।',
        'हर कॉन्टैक्ट पर इन्हें भरें। Wake words चालू हों तो "Personal" टैग वाले कॉन्टैक्ट को automatic जवाब नहीं जाता।',
      ],
    },
  },
  deals: {
    title: { en: 'Deals & currency', hi: 'Deals और currency' },
    intro: { en: 'The currency your deals are counted in.', hi: 'वह currency जिसमें आपकी deals गिनी जाती हैं।' },
    steps: {
      en: ['Choose your currency and save. New deals use it.'],
      hi: ['अपनी currency चुनें और save करें। नई deals इसी में बनेंगी।'],
    },
  },
  members: {
    title: { en: 'Team members', hi: 'टीम सदस्य' },
    intro: {
      en: 'Invite the people who work with you and decide what each may do.',
      hi: 'अपने साथ काम करने वालों को बुलाएं और तय करें कि कौन क्या कर सकता है।',
    },
    steps: {
      en: [
        'Click Invite member, enter the email and choose a role.',
        'Admin: everything except ownership. Agent: chats and daily work. Viewer: can only look.',
        'For an agent or viewer you can tick the modules they may open.',
        'The person gets a link to join. Your plan sets how many members of each role you may have.',
      ],
      hi: [
        'Invite member दबाएं, email डालें और role चुनें।',
        'Admin: मालिकाना हक़ छोड़कर सब कुछ। Agent: चैट और रोज़ का काम। Viewer: सिर्फ़ देख सकता है।',
        'Agent या viewer के लिए आप टिक कर सकते हैं कि वे कौन से मॉड्यूल खोल सकें।',
        'उस व्यक्ति को जुड़ने का लिंक मिलता है। हर role के कितने सदस्य हो सकते हैं, यह आपका प्लान तय करता है।',
      ],
    },
    links: [{ label: { en: 'Plans', hi: 'प्लान' }, url: '/plans' }],
  },
  menu: {
    title: { en: 'Menu modules', hi: 'मेनू के मॉड्यूल' },
    intro: {
      en: 'The owner chooses which modules the menu shows, so it holds only what the business uses.',
      hi: 'मालिक चुनता है कि मेनू में कौन से मॉड्यूल दिखें, ताकि उसमें वही रहे जो business इस्तेमाल करता है।',
    },
    steps: {
      en: [
        'Untick the modules you do not want in the menu and click Save menu.',
        'It applies to everyone in the account.',
        'A hidden module is not switched off and nothing is deleted. Tick it back any time.',
      ],
      hi: [
        'जो मॉड्यूल मेनू में नहीं चाहिए उनका टिक हटाएं और Save menu दबाएं।',
        'यह account के हर व्यक्ति पर लागू होता है।',
        'छिपाया हुआ मॉड्यूल बंद नहीं होता और कुछ भी delete नहीं होता। कभी भी वापस टिक करें।',
      ],
    },
  },
  apiKeys: {
    title: { en: 'API keys', hi: 'API keys' },
    intro: {
      en: 'Keys that let your own software or tools such as n8n talk to this portal.',
      hi: 'वे keys जिनसे आपका अपना software या n8n जैसे tools इस portal से बात कर सकें।',
    },
    steps: {
      en: [
        'Click New API key, give it a name and choose the WhatsApp number it works for.',
        'Copy the key at once: it is shown only one time.',
        'Send it with every request as the header "Authorization: Bearer <key>". The address starts with /api/v1.',
        'Revoke a key you no longer use.',
      ],
      hi: [
        'New API key दबाएं, नाम दें और वह WhatsApp नंबर चुनें जिसके लिए यह काम करेगी।',
        'Key तुरंत copy करें: यह सिर्फ़ एक बार दिखती है।',
        'हर request के साथ इसे header "Authorization: Bearer <key>" में भेजें। पता /api/v1 से शुरू होता है।',
        'जो key अब इस्तेमाल में नहीं, उसे revoke करें।',
      ],
    },
  },
} satisfies Record<string, HelpTopic>

export type HelpTopicKey = keyof typeof HELP_TOPICS

const SETTINGS_TABS: Record<string, HelpTopicKey> = {
  profile: 'profile',
  security: 'security',
  appearance: 'appearance',
  branding: 'branding',
  whatsapp: 'whatsapp',
  templates: 'templates',
  'quick-replies': 'quickReplies',
  inbox: 'inboxSettings',
  wishes: 'wishes',
  fields: 'fields',
  tags: 'fields',
  'custom-fields': 'fields',
  deals: 'deals',
  members: 'members',
  menu: 'menu',
  api: 'apiKeys',
}

const PAGES: { path: string; topic: HelpTopicKey }[] = [
  { path: '/dashboard', topic: 'dashboard' },
  { path: '/inbox', topic: 'inbox' },
  { path: '/notifications', topic: 'notifications' },
  { path: '/contacts', topic: 'contacts' },
  { path: '/pipelines', topic: 'pipelines' },
  { path: '/broadcasts', topic: 'broadcasts' },
  { path: '/posts', topic: 'posts' },
  { path: '/appointments', topic: 'appointments' },
  { path: '/events', topic: 'events' },
  { path: '/service', topic: 'service' },
  { path: '/automations', topic: 'automations' },
  { path: '/flows', topic: 'flows' },
  { path: '/agents', topic: 'agents' },
  { path: '/data', topic: 'data' },
  { path: '/plans', topic: 'plans' },
  { path: '/aeda-forms', topic: 'aedaForms' },
]

/** The help topic of a page; null where the portal has nothing to say. */
export function helpTopicForPage(pathname: string, settingsTab?: string | null): HelpTopicKey | null {
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    return (settingsTab && SETTINGS_TABS[settingsTab]) || 'settings'
  }
  const page = PAGES.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`))
  return page?.topic ?? null
}

/** A link that leaves the portal (opened in a new tab). */
export function isOutsideLink(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url)
}
