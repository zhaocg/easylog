using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.SceneManagement;

public sealed class EasyLogClient : MonoBehaviour
{
    public string ingestUrl = "http://127.0.0.1:3100/api/v1/logs";
    public string ingestToken = "";
    public string playerId = "";
    public string sessionId = "";
    public string deviceId = "";
    public string category = "unity";
    public int batchSize = 50;
    public float flushIntervalSeconds = 5f;
    public EasyLogLevel minimumLevel = EasyLogLevel.Warning;
    public string spoolFileName = "easylog_spool.jsonl";
    public int maxSpoolLines = 5000;
    public bool flushImmediatelyOnError = true;

    private readonly object spoolLock = new object();
    private string activeScene = "";
    private string buildVersion = "";
    private string platformName = "";
    private string spoolPath = "";
    private long eventSequence = 0;
    private int writesSinceTrim = 0;
    private volatile bool flushRequested = false;
    private bool flushInProgress = false;

    private void Awake()
    {
        DontDestroyOnLoad(gameObject);

        if (string.IsNullOrWhiteSpace(sessionId))
        {
            sessionId = Guid.NewGuid().ToString("N");
        }

        if (string.IsNullOrWhiteSpace(deviceId))
        {
            deviceId = SystemInfo.deviceUniqueIdentifier;
        }

        activeScene = SceneManager.GetActiveScene().name;
        buildVersion = Application.version;
        platformName = Application.platform.ToString();
        spoolPath = ResolveSpoolPath();
        SceneManager.sceneLoaded += OnSceneLoaded;
        Application.logMessageReceivedThreaded += OnLogMessageReceived;
        Application.quitting += OnApplicationQuitting;
        StartCoroutine(FlushLoop());
        RequestFlush();
    }

    private void OnDestroy()
    {
        SceneManager.sceneLoaded -= OnSceneLoaded;
        Application.logMessageReceivedThreaded -= OnLogMessageReceived;
        Application.quitting -= OnApplicationQuitting;
    }

    private void Update()
    {
        TryStartRequestedFlush();
    }

    private void OnApplicationPause(bool pauseStatus)
    {
        if (pauseStatus)
        {
            RequestFlush();
            TryStartRequestedFlush();
        }
    }

    private void OnApplicationFocus(bool hasFocus)
    {
        if (!hasFocus)
        {
            RequestFlush();
            TryStartRequestedFlush();
        }
    }

    private void OnApplicationQuitting()
    {
        RequestFlush();
        TryStartRequestedFlush();
    }

    public void SetPlayer(string id)
    {
        playerId = id ?? "";
    }

    public void Track(string message, EasyLogLevel level = EasyLogLevel.Info, string customCategory = "")
    {
        if (!ShouldCapture(level)) return;
        Enqueue(message, "", ToLevelString(level), string.IsNullOrWhiteSpace(customCategory) ? category : customCategory);
    }

    public string GetLogDirectoryPath()
    {
        string directoryPath = Path.GetDirectoryName(ResolveSpoolPath());
        return string.IsNullOrWhiteSpace(directoryPath) ? Application.persistentDataPath : directoryPath;
    }

    [ContextMenu("Open EasyLog Log Directory")]
    public void OpenLogDirectory()
    {
        string directoryPath = GetLogDirectoryPath();
        Directory.CreateDirectory(directoryPath);

#if UNITY_EDITOR
        UnityEditor.EditorUtility.RevealInFinder(directoryPath);
#else
        Application.OpenURL(new Uri(directoryPath).AbsoluteUri);
#endif
    }

    private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
    {
        activeScene = scene.name;
    }

    private void OnLogMessageReceived(string condition, string stackTrace, LogType type)
    {
        EasyLogLevel level = MapLevel(type);
        if (!ShouldCapture(level)) return;
        Enqueue(condition, stackTrace, ToLevelString(level), category);
    }

    private void Enqueue(string message, string stackTrace, string level, string entryCategory)
    {
        EasyLogEntry entry = new EasyLogEntry
        {
            eventId = NextEventId(),
            timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            level = level,
            message = message ?? "",
            stackTrace = stackTrace ?? "",
            category = entryCategory ?? "",
            playerId = playerId ?? "",
            sessionId = sessionId ?? "",
            buildVersion = buildVersion,
            platform = platformName,
            scene = activeScene ?? "",
            deviceId = deviceId ?? ""
        };

        WriteToSpool(entry);
        if (flushImmediatelyOnError && IsUrgentLevel(level))
        {
            RequestFlush();
        }
    }

    private string NextEventId()
    {
        long sequence = Interlocked.Increment(ref eventSequence);
        string sessionPart = string.IsNullOrWhiteSpace(sessionId) ? "session" : sessionId;
        return string.Concat(sessionPart, "-", sequence.ToString());
    }

    private string ResolveSpoolPath()
    {
        if (!string.IsNullOrWhiteSpace(spoolPath)) return spoolPath;

        string fileName = string.IsNullOrWhiteSpace(spoolFileName) ? "easylog_spool.jsonl" : spoolFileName;
        return Path.Combine(Application.persistentDataPath, fileName);
    }

    private IEnumerator FlushLoop()
    {
        while (true)
        {
            yield return new WaitForSeconds(flushIntervalSeconds);
            if (!string.IsNullOrWhiteSpace(ingestToken))
            {
                yield return Flush();
            }
        }
    }

    public IEnumerator Flush()
    {
        if (flushInProgress || string.IsNullOrWhiteSpace(ingestToken)) yield break;

        flushInProgress = true;
        int consumedLines;
        List<EasyLogEntry> logs = ReadSpoolBatch(out consumedLines);
        if (logs.Count == 0)
        {
            if (consumedLines > 0)
            {
                RemoveConsumedLines(consumedLines);
            }
            flushInProgress = false;
            yield break;
        }

        string payload = JsonUtility.ToJson(new EasyLogBatch { logs = logs });
        using (UnityWebRequest request = new UnityWebRequest(ingestUrl, "POST"))
        {
            byte[] body = System.Text.Encoding.UTF8.GetBytes(payload);
            request.uploadHandler = new UploadHandlerRaw(body);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Authorization", "Bearer " + ingestToken);
            yield return request.SendWebRequest();

            if (request.result == UnityWebRequest.Result.Success)
            {
                RemoveConsumedLines(consumedLines);
            }
        }

        flushInProgress = false;
    }

    private void RequestFlush()
    {
        flushRequested = true;
    }

    private void TryStartRequestedFlush()
    {
        if (!flushRequested || flushInProgress || string.IsNullOrWhiteSpace(ingestToken)) return;
        flushRequested = false;
        StartCoroutine(Flush());
    }

    private void WriteToSpool(EasyLogEntry entry)
    {
        if (string.IsNullOrWhiteSpace(spoolPath)) return;

        string line = JsonUtility.ToJson(entry);
        lock (spoolLock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(spoolPath));
            File.AppendAllText(spoolPath, line + Environment.NewLine);
            writesSinceTrim += 1;
            if (writesSinceTrim >= 100)
            {
                writesSinceTrim = 0;
                TrimSpoolIfNeeded();
            }
        }
    }

    private List<EasyLogEntry> ReadSpoolBatch(out int consumedLines)
    {
        consumedLines = 0;
        List<EasyLogEntry> logs = new List<EasyLogEntry>();
        if (string.IsNullOrWhiteSpace(spoolPath)) return logs;

        lock (spoolLock)
        {
            if (!File.Exists(spoolPath)) return logs;

            string[] lines = File.ReadAllLines(spoolPath);
            int targetBatchSize = Math.Max(1, batchSize);
            for (int i = 0; i < lines.Length && logs.Count < targetBatchSize; i++)
            {
                consumedLines += 1;
                if (string.IsNullOrWhiteSpace(lines[i])) continue;

                try
                {
                    logs.Add(JsonUtility.FromJson<EasyLogEntry>(lines[i]));
                }
                catch
                {
                    // Drop malformed local spool lines after the next successful flush attempt.
                }
            }
        }

        return logs;
    }

    private void RemoveConsumedLines(int consumedLines)
    {
        if (consumedLines <= 0 || string.IsNullOrWhiteSpace(spoolPath)) return;

        lock (spoolLock)
        {
            if (!File.Exists(spoolPath)) return;

            string[] lines = File.ReadAllLines(spoolPath);
            if (consumedLines >= lines.Length)
            {
                File.Delete(spoolPath);
                return;
            }

            List<string> remaining = new List<string>();
            for (int i = consumedLines; i < lines.Length; i++)
            {
                remaining.Add(lines[i]);
            }
            File.WriteAllLines(spoolPath, remaining.ToArray());
        }
    }

    private void TrimSpoolIfNeeded()
    {
        if (maxSpoolLines <= 0 || !File.Exists(spoolPath)) return;

        string[] lines = File.ReadAllLines(spoolPath);
        if (lines.Length <= maxSpoolLines) return;

        List<string> kept = new List<string>();
        for (int i = lines.Length - maxSpoolLines; i < lines.Length; i++)
        {
            kept.Add(lines[i]);
        }
        File.WriteAllLines(spoolPath, kept.ToArray());
    }

    private bool ShouldCapture(EasyLogLevel level)
    {
        return (int)level >= (int)minimumLevel;
    }

    private static bool IsUrgentLevel(string level)
    {
        return level == "error" || level == "exception" || level == "fatal";
    }

    private static EasyLogLevel MapLevel(LogType type)
    {
        switch (type)
        {
            case LogType.Warning:
                return EasyLogLevel.Warning;
            case LogType.Error:
            case LogType.Assert:
                return EasyLogLevel.Error;
            case LogType.Exception:
                return EasyLogLevel.Exception;
            default:
                return EasyLogLevel.Info;
        }
    }

    private static string ToLevelString(EasyLogLevel level)
    {
        switch (level)
        {
            case EasyLogLevel.Trace:
                return "trace";
            case EasyLogLevel.Debug:
                return "debug";
            case EasyLogLevel.Warning:
                return "warn";
            case EasyLogLevel.Error:
                return "error";
            case EasyLogLevel.Exception:
                return "exception";
            case EasyLogLevel.Fatal:
                return "fatal";
            default:
                return "info";
        }
    }
}

public enum EasyLogLevel
{
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warning = 3,
    Error = 4,
    Exception = 5,
    Fatal = 6
}

[Serializable]
public sealed class EasyLogBatch
{
    public List<EasyLogEntry> logs;
}

[Serializable]
public sealed class EasyLogEntry
{
    public string eventId;
    public string timestamp;
    public string level;
    public string message;
    public string stackTrace;
    public string category;
    public string playerId;
    public string sessionId;
    public string buildVersion;
    public string platform;
    public string scene;
    public string deviceId;
}
