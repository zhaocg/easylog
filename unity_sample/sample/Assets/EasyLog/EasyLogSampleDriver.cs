using System;
using System.Collections;
using UnityEngine;

public sealed class EasyLogSampleDriver : MonoBehaviour
{
    public string samplePlayerId = "unity-sample-player";

    private IEnumerator Start()
    {
        yield return null;

        EasyLogClient logger = FindObjectOfType<EasyLogClient>();
        if (logger != null)
        {
            logger.SetPlayer(samplePlayerId);
            logger.Track("EasyLog Unity sample started.", EasyLogLevel.Info, "sample");
        }

        Debug.LogWarning("EasyLog sample warning from Unity.");

        try
        {
            throw new InvalidOperationException("EasyLog sample exception.");
        }
        catch (Exception exception)
        {
            Debug.LogException(exception);
        }

        yield return new WaitForSeconds(0.2f);
        if (logger != null)
        {
            yield return logger.Flush();
        }

        Debug.Log("这是一条测试日志，包含中文字符。");
    }
}
