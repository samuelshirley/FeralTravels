export interface DemoLeg {
  sort_order: number;
  title: string;
  label: string;
  start_name: string;
  end_name: string;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  dates: string;
  distance_km: number | null;
  drive_time_minutes: number | null;
  terrain: string;
  overnight: string;
  status: string;
  color: string;
  notes: string[];
  costs: { item: string; est: string; isTotal?: boolean }[];
  links?: { label: string; url: string; type: string }[];
}

export const DEMO_TRIP = {
  name: 'Girona → Nordkapp',
  start_date: '2026-05-28',
  end_date: '2026-06-24',
  status: 'planning' as const,
};

export const DEMO_LEGS: DemoLeg[] = [
  {
    sort_order: 1,
    title: 'Girona → Italian Border',
    label: 'LEG 1',
    start_name: 'Girona',
    end_name: 'Italian Border (Liguria)',
    start_lat: 41.9794, start_lng: 2.8214,
    end_lat: 44.4056, end_lng: 8.9463,
    dates: '~May 28',
    distance_km: 650,
    drive_time_minutes: 390,
    terrain: 'Highway',
    overnight: 'Rest stop / Aire in southern France or Liguria',
    color: '#E8927C',
    status: 'planning',
    notes: [
      'Straight shot on AP-7 → A9 through France → Italian autostrada',
      'Consider stopping near Genoa or the Ligurian coast for the night',
      'Fill up diesel before crossing into Italy (cheaper in Spain)',
      'Dogs: stretch stops every 2–3 hrs',
    ],
    costs: [],
    links: [{ label: 'Google Maps Route', url: 'https://www.google.com/maps/dir/Girona/Genoa', type: 'maps' }],
  },
  {
    sort_order: 2,
    title: 'Northern Italy → Alpine Crossing',
    label: 'LEG 2',
    start_name: 'Italian Border (Liguria)',
    end_name: 'Alpine Pass',
    start_lat: 44.4056, start_lng: 8.9463,
    end_lat: 46.9067, end_lng: 11.4583,
    dates: '~May 29',
    distance_km: 400,
    drive_time_minutes: 360,
    terrain: 'Highway → Gravel/Mountain Pass',
    overnight: 'Wild camp near pass summit or alpine meadow',
    color: '#7CB5E8',
    status: 'research',
    notes: [
      'Highway through Po Valley to Brenner area or Dolomites',
      'Alpine pass options for gravel crossing',
      'Check pass opening status — many above 2,000m don\'t open until late May/June',
      'Park for the night at or near the pass — this is your scenic camp night',
    ],
    costs: [
      { item: 'Timmelsjoch toll (if applicable)', est: '€16–18' },
      { item: 'Italian autostrada tolls', est: '~€25–35' },
    ],
  },
  {
    sort_order: 3,
    title: 'Innsbruck — Visit Friend',
    label: 'LEG 3',
    start_name: 'Alpine Pass',
    end_name: 'Innsbruck',
    start_lat: 46.9067, start_lng: 11.4583,
    end_lat: 47.2692, end_lng: 11.4041,
    dates: '~May 30–31',
    distance_km: 0,
    drive_time_minutes: 0,
    terrain: 'City / Driveway',
    overnight: "Friend's driveway / local Stellplatz",
    color: '#7CE8A3',
    status: 'confirmed',
    notes: [
      '2 nights in Innsbruck with your friend',
      'Park4Night or Stellplatz if not staying in driveway',
      'Explore city, brewery, alpine views',
      'Good chance to resupply, do laundry, charge up',
    ],
    costs: [{ item: 'Stellplatz (if needed)', est: '€10–20/night' }],
  },
  {
    sort_order: 4,
    title: 'Innsbruck → Bad Kissingen',
    label: 'LEG 4',
    start_name: 'Innsbruck',
    end_name: 'Bad Kissingen',
    start_lat: 47.2692, start_lng: 11.4041,
    end_lat: 50.2268, end_lng: 10.0770,
    dates: 'Jun 1–2 → Arrive Jun 3 by 1 PM',
    distance_km: 430,
    drive_time_minutes: 270,
    terrain: 'Highway / Autobahn',
    overnight: 'Camp en route or push through',
    color: '#E8D57C',
    status: 'anchored',
    notes: [
      'Easy drive — could do it in one shot or split with a camp night',
      'Austrian Vignette required for autobahn (10-day = €11.50)',
      'CRITICAL: Camp Area opens Wed Jun 3 at 1:00 PM sharp',
      'First come, first served — aim for 1–2 PM arrival',
    ],
    costs: [
      { item: 'Austrian Vignette (10-day)', est: '€11.50' },
      { item: 'Camp Area fee (TBD)', est: '~€20–40?' },
    ],
  },
  {
    sort_order: 5,
    title: 'Abenteuer & Allrad',
    label: 'LEG 5',
    start_name: 'Bad Kissingen',
    end_name: 'Bad Kissingen',
    start_lat: 50.2268, start_lng: 10.0770,
    end_lat: 50.2268, end_lng: 10.0770,
    dates: 'Jun 3 (PM) – Jun 7',
    distance_km: 0,
    drive_time_minutes: 0,
    terrain: 'Camp Area / Exhibition',
    overnight: 'Camp Area (Saalewiesen, Bad Kissingen)',
    color: '#C87CE8',
    status: 'anchored',
    notes: [
      'Exhibition runs Thu Jun 4 – Sun Jun 7',
      '400+ exhibitors, 110,000 sqm',
      'Must vacate Camp Area by Sun Jun 7, 10 PM',
    ],
    costs: [
      { item: 'Day ticket', est: '€20' },
      { item: '4-day pass', est: '~€45' },
    ],
  },
  {
    sort_order: 6,
    title: 'Bad Kissingen → Nürburgring',
    label: 'LEG 6',
    start_name: 'Bad Kissingen',
    end_name: 'Nürburgring',
    start_lat: 50.2268, start_lng: 10.0770,
    end_lat: 50.3356, end_lng: 6.9475,
    dates: 'Jun 7 or Jun 8',
    distance_km: 280,
    drive_time_minutes: 180,
    terrain: 'Autobahn',
    overnight: 'Camp near Nürburg / parking lot',
    color: '#E87C7C',
    status: 'planning',
    notes: [
      'Short easy drive',
      'RingFreaks — BMW E90 330i: 3.0L inline-6, 270hp, 6-speed MANUAL',
      'A Nordschleife lap = ~9 min at moderate pace (20.8 km)',
    ],
    costs: [
      { item: 'BMW E90 330i — 10 laps (basic)', est: '€999' },
      { item: '2× instructor laps', est: '€98' },
      { item: 'Premium insurance', est: '€99' },
      { item: 'TOTAL ESTIMATE', est: '~€1,550–1,580', isTotal: true },
    ],
    links: [{ label: 'RingFreaks Booking', url: 'https://www.ringfreaks.com', type: 'booking' }],
  },
  {
    sort_order: 7,
    title: 'Nürburgring → Denmark Beach',
    label: 'LEG 7',
    start_name: 'Nürburgring',
    end_name: 'Denmark Beach',
    start_lat: 50.3356, start_lng: 6.9475,
    end_lat: 57.7000, end_lng: 10.6000,
    dates: '~Jun 9–10',
    distance_km: 850,
    drive_time_minutes: 510,
    terrain: 'Autobahn → Danish back roads',
    overnight: 'Beach camp (saved spot)',
    color: '#7CCFE8',
    status: 'planning',
    notes: [
      'Split into 2 days — camp somewhere in northern Germany',
      'Denmark: beach camping technically not allowed but widely practiced',
      '1–2 nights max — don\'t push your luck on enforcement',
    ],
    costs: [{ item: 'German fuel + food', est: '~€100–150' }],
  },
  {
    sort_order: 8,
    title: 'Denmark → Oslo',
    label: 'LEG 8',
    start_name: 'Denmark Beach',
    end_name: 'Oslo',
    start_lat: 57.7000, start_lng: 10.6000,
    end_lat: 59.9139, end_lng: 10.7522,
    dates: '~Jun 12–13',
    distance_km: 600,
    drive_time_minutes: 420,
    terrain: 'Highway / Ferry',
    overnight: 'Van parking / Park4Night near Oslo center',
    color: '#A3E87C',
    status: 'planning',
    notes: [
      'Route options: Øresund Bridge → Swedish coast → Oslo, or ferry Hirtshals → Kristiansand/Larvik',
      'Oslo: 3–4 days exploring',
    ],
    costs: [
      { item: 'Ferry (if taking)', est: '€150–250' },
      { item: 'Oslo parking (3–4 nights)', est: '€60–120' },
    ],
  },
  {
    sort_order: 9,
    title: 'Oslo → Nordkapp',
    label: 'LEG 9',
    start_name: 'Oslo',
    end_name: 'Nordkapp',
    start_lat: 59.9139, start_lng: 10.7522,
    end_lat: 71.1685, end_lng: 25.7838,
    dates: '~Jun 17 → Jun 22–24',
    distance_km: 1800,
    drive_time_minutes: 0,
    terrain: 'Highways → Mountain roads → Arctic coast',
    overnight: 'Mix of wild camping + campsites',
    color: '#E8C17C',
    status: 'planning',
    notes: [
      'Midnight sun at Nordkapp: May 12 – July 31',
      'Summer solstice: Jun 20–21 = sun highest at midnight = PEAK experience',
      'Fill up fuel at EVERY opportunity north of Trondheim',
      'Target arrival: ~Jun 20–21 for solstice midnight sun',
    ],
    costs: [
      { item: 'Norwegian fuel (~1,800 km)', est: '€300–400' },
      { item: 'Nordkapp entrance fee', est: '€30–35' },
    ],
  },
];
