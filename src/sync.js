import { getActivity } from './wakatime.js';
import { addEntry, createProject, getInfo } from './toggl.js';
import ora from 'ora';

const MERGE_GAP_SECONDS = 15 * 60; // 15 minutes
const MIN_ENTRY_DURATION = 10 * 60; // 10 minutes

export default async function (flags) {
  // Call WakaTime and Toggl APIs
  const rawActivity = await getActivity(flags.day, flags.minDuration, flags.wakatime);
  const togglInfo = await getInfo(flags.toggl);

  // Merge nearby entries for the same project and enforce minimum duration
  const wakaTimeActivity = applyMinimumDuration(mergeEntries(rawActivity));
  if (wakaTimeActivity.length < rawActivity.length) {
    ora(`Merged ${rawActivity.length} entries into ${wakaTimeActivity.length}.`).info();
  }

  // List all WakaTime projects
  const wakaTimeProjects = Object.keys(
    wakaTimeActivity.reduce((acc, act) => {
      acc[act.project] = act;
      return acc;
    }, {}),
  );

  // Find which projects are not in Toggl yet
  // const projectsToCreate = wakaTimeProjects.filter(
  //     (p) => !togglInfo.projects.find((t) => t.name.toLowerCase() === p.toLowerCase()),
  // );

  // // Create projects in Toggl
  // for (const project of projectsToCreate) {
  //     const created = await createProject(project, togglInfo.workspaceId, flags.toggl);
  //     togglInfo.projects.push(created);
  //     await sleep(1000); // One request / second to avoid hitting the limit
  // }

  const projectIds = togglInfo.projects.reduce((acc, p) => {
    acc[p.name.toLowerCase()] = p.id;
    return acc;
  }, {});

  // Add WakaTime entries to Toggl
  let added = 0;
  let duplicates = 0;
  let projects = {};
  const spinner = ora('Adding entries to Toggl...').start();
  for (const entry of wakaTimeActivity) {
    const projectId = projectIds[entry.project.toLowerCase()];
    if (!projectId) {
      continue;
      throw new Error(`project "${entry.project}" doesn't exist in Toggl`);
    }
    const start = new Date(Math.round(entry.time) * 1000).toISOString();
    const duration = Math.round(entry.duration);
    if (alreadyExists(projectId, start, duration, togglInfo.entries)) {
      duplicates++;
      spinner.text = `Added ${added}/${wakaTimeActivity.length} entries to Toggl... Found ${duplicates} duplicates`;
      continue;
    }

    await addEntry(projectId, togglInfo.workspaceId, start, duration, flags.toggl);
    spinner.text = `Added ${added}/${wakaTimeActivity.length} entries to Toggl...`;

    if (duplicates > 0) {
      spinner.text += ` Found ${duplicates} duplicates`;
    }
    projects[projectId] = true;
    added++;
    await sleep(1000); // One request / second to avoid hitting the limit
  }
  spinner.succeed(`Added ${added} time entries to ${Object.keys(projects).length} project(s).`);
  if (duplicates > 0) {
    ora(`${duplicates} entries were already in Toggl.`).info();
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function alreadyExists(projectId, start, duration, entries) {
  return Boolean(
    entries.find(
      (entry) =>
        entry.start.substr(0, 19) === start.substr(0, 19) && entry.duration === duration && entry.pid === projectId,
    ),
  );
}

function mergeEntries(entries) {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => {
    const projCmp = a.project.toLowerCase().localeCompare(b.project.toLowerCase());
    if (projCmp !== 0) return projCmp;
    return a.time - b.time;
  });

  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    const prevEnd = prev.time + prev.duration;
    const gap = curr.time - prevEnd;

    if (curr.project.toLowerCase() === prev.project.toLowerCase() && gap <= MERGE_GAP_SECONDS) {
      prev.duration = curr.time + curr.duration - prev.time;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

function applyMinimumDuration(entries) {
  return entries.map((entry) => {
    if (entry.duration < MIN_ENTRY_DURATION) {
      return { ...entry, duration: MIN_ENTRY_DURATION };
    }
    return entry;
  });
}
